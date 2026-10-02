package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
)

// DriveRepository 读 drives 表。
type DriveRepository struct {
	db *d1.Client
}

// NewDriveRepository 构造网盘仓储。
func NewDriveRepository(db *d1.Client) *DriveRepository { return &DriveRepository{db: db} }

// DefaultDrive 取用户的默认网盘。
//
// 与 Node 侧 DriveRepository 的选择顺序一致:优先 is_default,
// 没有就退回最近创建的一个(status='active')。直接按 created_at 取
// 最新一个会在用户换过网盘时选错 —— 那个网盘可能已停用。
func (r *DriveRepository) DefaultDrive(ctx context.Context, userID string) (*drive.Drive, error) {
	row, err := r.db.FetchOne(ctx, `
		SELECT id, user_id, name, type, config_data, remote_folder, status, is_default
		FROM drives
		WHERE user_id = ? AND status = 'active'
		ORDER BY is_default DESC, created_at DESC
		LIMIT 1`, userID)
	if err != nil {
		return nil, fmt.Errorf("查询用户 %s 的默认网盘失败: %w", userID, err)
	}
	if row == nil {
		return nil, nil
	}
	return rowToDrive(row)
}

// DriveByID 按主键取网盘。
func (r *DriveRepository) DriveByID(ctx context.Context, id string) (*drive.Drive, error) {
	row, err := r.db.FetchOne(ctx, `
		SELECT id, user_id, name, type, config_data, remote_folder, status, is_default
		FROM drives WHERE id = ?`, id)
	if err != nil {
		return nil, fmt.Errorf("查询网盘 %s 失败: %w", id, err)
	}
	if row == nil {
		return nil, nil
	}
	return rowToDrive(row)
}

func rowToDrive(row map[string]interface{}) (*drive.Drive, error) {
	d := &drive.Drive{
		ID:           str(row["id"]),
		UserID:       str(row["user_id"]),
		Name:         str(row["name"]),
		Type:         str(row["type"]),
		RemoteFolder: nullOf(str(row["remote_folder"])),
		Status:       str(row["status"]),
	}

	if f, ok := row["is_default"].(float64); ok {
		d.IsDefault = int(f)
	}

	// config_data 是明文 JSON(Node 侧就是 JSON.parse)。
	// D1 有时把它当 TEXT 返回、有时当对象返回,两种都要处理。
	raw := row["config_data"]
	switch v := raw.(type) {
	case nil:
		return nil, fmt.Errorf("网盘 %s 没有 config_data", d.ID)
	case string:
		if err := json.Unmarshal([]byte(v), &d.Config); err != nil {
			return nil, fmt.Errorf("网盘 %s 的 config_data 不是合法 JSON: %w", d.ID, err)
		}
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("网盘 %s 的 config_data 无法序列化: %w", d.ID, err)
		}
		if err := json.Unmarshal(b, &d.Config); err != nil {
			return nil, fmt.Errorf("网盘 %s 的 config_data 结构不符: %w", d.ID, err)
		}
	}
	return d, nil
}
