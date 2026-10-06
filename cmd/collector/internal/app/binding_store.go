package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
)

// 本文件是绑定向导需要的 drives 表写操作。
//
// store.DriveRepository 只实现了读+UpdateConfigData(上传链路够用);
// 绑定流程需要建/删/设默认/设目录,在这里补齐 —— 直接持 D1 客户端。
// 等绑定流程稳定后可整体挪进 store,这里刻意先不扩散接口。

// bindDriveReady 报告绑定向导的写链路是否装配完整。
func (a *App) bindDriveReady() bool { return a != nil && a.d1c != nil && a.bindSessions != nil }

// ClearUserSessions 清掉用户的全部残留会话 —— 封禁成功后由
// Dispatcher 调用,与 JS 侧 SessionManager.clear(targetUid) 对齐。
//
// 非可选的理由:绑定会话的 TempData 里存着邮箱密码这类凭据。
// 封了人却把会话留在 Redis 里,等于让密码一直挂到 TTL 到期。
// 扫描状态同理 —— 留着的话解封后用户会翻到一页早就不存在的旧结果。
//
// 盘锁(SessionLock)是进程内 mutex 且 defer 释放,不用清;正在跑的
// 任务 JS 侧也不取消,保持一致(要取消得走任务状态机,另一件事)。
func (a *App) ClearUserSessions(ctx context.Context, userID string) error {
	var firstErr error
	keep := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if a.bindSessions != nil {
		keep(a.bindSessions.Clear(ctx, userID))
	}
	if a.cfg.Redis != nil {
		keep(a.cfg.Redis.Del(ctx, dupScanKey(userID)).Err())
	}
	return firstErr
}

// insertDrive 插入新绑定,复用 JS 侧 DriveRepository.create 的语义:
//   - id 形如 drive_<ts>_<8位随机>
//   - 同类型已有 deleted 行时复活它(JS 侧复活时显式把 remote_folder 清 NULL)
//   - 用户还没有 active 盘时,新盘自动成为默认盘
func (a *App) insertDrive(ctx context.Context, userID, name, typeStr string, cfg drive.DriveConfig) error {
	deleted, err := a.d1c.FetchOne(ctx,
		`SELECT id, created_at FROM drives
		 WHERE user_id = ? AND type = ? AND status = 'deleted'
		 ORDER BY updated_at DESC, created_at DESC LIMIT 1`, userID, typeStr)
	if err != nil {
		return fmt.Errorf("查询已删除网盘失败: %w", err)
	}

	blob, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("序列化 config_data 失败: %w", err)
	}
	now := time.Now().UnixMilli()

	active, err := a.drivesList(ctx, userID)
	if err != nil {
		return err
	}
	isDefault := 0
	if len(active) == 0 {
		isDefault = 1
	}

	if deleted != nil {
		id := strOf(deleted["id"])
		created := now
		if f, ok := deleted["created_at"].(float64); ok && f > 0 {
			created = int64(f)
		}
		if _, err := a.d1c.Exec(ctx,
			`UPDATE drives SET name = ?, config_data = ?, remote_folder = NULL,
			    status = 'active', is_default = ?, updated_at = ?
			 WHERE id = ? AND user_id = ? AND type = ? AND status = 'deleted'`,
			name, string(blob), isDefault, now, id, userID, typeStr); err != nil {
			return fmt.Errorf("复活网盘 %s 失败: %w", id, err)
		}
		_ = created // created_at 沿用原值,不需要写
		return nil
	}

	id, err := newDriveID()
	if err != nil {
		return err
	}
	if _, err := a.d1c.Exec(ctx,
		`INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		id, userID, name, typeStr, string(blob), isDefault, now, now); err != nil {
		return fmt.Errorf("插入网盘失败: %w", err)
	}
	return nil
}

// deleteDrive 软删(与 JS 一致:status='deleted',不物理删)。
// 删的是默认盘时,把最近的一个 active 盘顶上(与 JS ensureDefault 一致)。
func (a *App) deleteDrive(ctx context.Context, userID, driveID string) error {
	if _, err := a.d1c.Exec(ctx,
		`UPDATE drives SET status = 'deleted', is_default = 0, updated_at = ?
		 WHERE id = ? AND user_id = ?`, time.Now().UnixMilli(), driveID, userID); err != nil {
		return fmt.Errorf("删除网盘 %s 失败: %w", driveID, err)
	}
	remaining, err := a.drivesList(ctx, userID)
	if err != nil {
		return err
	}
	for i := range remaining {
		if remaining[i].Status == "active" && remaining[i].IsDefault == 1 {
			return nil // 还有默认盘,不用补
		}
	}
	for i := range remaining {
		if remaining[i].Status == "active" {
			return a.setDefault(ctx, userID, remaining[i].ID)
		}
	}
	return nil
}

// setDefault 把某盘设为默认(先清后设,与 JS _writeDefaultDrive 一致)。
func (a *App) setDefault(ctx context.Context, userID, driveID string) error {
	if _, err := a.d1c.Exec(ctx,
		`UPDATE drives SET is_default = 0 WHERE user_id = ? AND is_default = 1`, userID); err != nil {
		return fmt.Errorf("清除旧默认盘失败: %w", err)
	}
	if _, err := a.d1c.Exec(ctx,
		`UPDATE drives SET is_default = 1, updated_at = ?
		 WHERE id = ? AND user_id = ? AND status = 'active'`,
		time.Now().UnixMilli(), driveID, userID); err != nil {
		return fmt.Errorf("设默认盘失败: %w", err)
	}
	return nil
}

// setRemoteFolder 更新默认盘(或指定盘)的保存目录。
func (a *App) setRemoteFolder(ctx context.Context, userID, driveID, folder string) error {
	if driveID == "" {
		d, err := a.drives.DefaultDrive(ctx, userID)
		if err != nil {
			return err
		}
		if d == nil {
			return fmt.Errorf("还没有绑定网盘,先用 /drive 绑定")
		}
		driveID = d.ID
	}
	if _, err := a.d1c.Exec(ctx,
		`UPDATE drives SET remote_folder = ?, updated_at = ?
		 WHERE id = ? AND user_id = ? AND status = 'active'`,
		folder, time.Now().UnixMilli(), driveID, userID); err != nil {
		return fmt.Errorf("更新保存目录失败: %w", err)
	}
	return nil
}

// drivesList 读用户全部 active 盘(绑定向导复用;也供面板展示)。
func (a *App) drivesList(ctx context.Context, userID string) ([]drive.Drive, error) {
	rows, err := a.d1c.FetchAll(ctx,
		`SELECT id, user_id, name, type, config_data, remote_folder, status, is_default
		 FROM drives WHERE user_id = ? AND status = 'active'
		 ORDER BY is_default DESC, created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("查询用户 %s 的网盘失败: %w", userID, err)
	}
	out := make([]drive.Drive, 0, len(rows))
	for _, row := range rows {
		d, err := driveFromRow(row)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, nil
}

// driveFromRow 把一行 D1 结果转成 drive.Drive。
// store.rowToDrive 是小写私有的,这里复制一份精简版 —— 挪进 store 时删。
func driveFromRow(row map[string]interface{}) (*drive.Drive, error) {
	d := &drive.Drive{
		ID:     strOf(row["id"]),
		UserID: strOf(row["user_id"]),
		Name:   strOf(row["name"]),
		Type:   strOf(row["type"]),
		Status: strOf(row["status"]),
	}
	if f, ok := row["is_default"].(float64); ok {
		d.IsDefault = int(f)
	}
	if s, ok := row["remote_folder"].(string); ok && s != "" {
		d.RemoteFolder.Valid = true
		d.RemoteFolder.String = s
	}
	raw := row["config_data"]
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &d.Config); err != nil {
			return nil, fmt.Errorf("网盘 %s 的 config_data 不是合法 JSON: %w", d.ID, err)
		}
	default:
		if v != nil {
			blob, err := json.Marshal(v)
			if err != nil {
				return nil, fmt.Errorf("网盘 %s 的 config_data 无法序列化: %w", d.ID, err)
			}
			if err := json.Unmarshal(blob, &d.Config); err != nil {
				return nil, fmt.Errorf("网盘 %s 的 config_data 结构不符: %w", d.ID, err)
			}
		}
	}
	return d, nil
}

// newDriveID 生成 drive_<ts>_<8随机> 主键(与 JS 格式一致)。
func newDriveID() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("生成网盘 ID 失败: %w", err)
	}
	return fmt.Sprintf("drive_%d_%s", time.Now().UnixMilli(), hex.EncodeToString(b[:])), nil
}

func strOf(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
