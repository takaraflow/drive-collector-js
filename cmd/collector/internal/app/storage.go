package app

// /storage —— 查询网盘剩余空间与容量配额。
//
// 对应 rclone about --json，支持 MEGA、Proton Drive、PikPak、Filen 以及实现了
// RFC 4331 的 WebDAV 网盘。对于 S3/OSS 等不支持配额查询的后端做优雅降级展示。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

const (
	storageLoadTimeout  = 45 * time.Second
	storageRefreshDelay = 400 * time.Millisecond
	storageDefaultTTL   = 2 * time.Minute

	storagePlaceholder = "⏳ <b>正在查询网盘空间信息...</b>\n\n请稍候，通常需要数秒完成。"
	storageSyncing     = "🔄 <b>正在重新查询网盘空间信息...</b>"
	storageRefreshOK   = "容量信息已刷新"
)

type storageMemEntry struct {
	info        *rclone.AboutInfo
	unsupported bool
	errStr      string
	expires     time.Time
	updatedAt   time.Time
}

type storageCacheBlob struct {
	Info        *rclone.AboutInfo `json:"info,omitempty"`
	Unsupported bool              `json:"unsupported,omitempty"`
	ErrStr      string            `json:"errStr,omitempty"`
	Timestamp   int64             `json:"timestamp"`
}

func storageCacheKey(d *drive.Drive) string {
	id := d.ID
	if id == "" {
		id = d.Type
	}
	return fmt.Sprintf("storage_%s_%s", d.UserID, id)
}

func (a *App) storageMemGet(key string) (*rclone.AboutInfo, bool, string, time.Time, bool) {
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	e, ok := a.storageMem[key]
	if !ok || time.Now().After(e.expires) {
		return nil, false, "", time.Time{}, false
	}
	return e.info, e.unsupported, e.errStr, e.updatedAt, true
}

func (a *App) storageMemSet(key string, info *rclone.AboutInfo, unsupported bool, errStr string, updatedAt time.Time, ttl time.Duration) {
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	if a.storageMem == nil {
		a.storageMem = map[string]storageMemEntry{}
	}
	if updatedAt.IsZero() {
		updatedAt = time.Now()
	}
	a.storageMem[key] = storageMemEntry{
		info:        info,
		unsupported: unsupported,
		errStr:      errStr,
		updatedAt:   updatedAt,
		expires:     time.Now().Add(ttl),
	}
}

func (a *App) storageRedisGet(ctx context.Context, key string) (*rclone.AboutInfo, bool, string, time.Time, bool) {
	if a.cfg.Redis == nil {
		return nil, false, "", time.Time{}, false
	}
	raw, err := a.cfg.Redis.Get(ctx, key).Result()
	if err != nil {
		if err != redis.Nil {
			a.log.Warn("storage 缓存读取失败", "key", key, "err", err)
		}
		return nil, false, "", time.Time{}, false
	}
	var blob storageCacheBlob
	if err := json.Unmarshal([]byte(raw), &blob); err != nil {
		a.log.Warn("storage 缓存解析失败", "key", key, "err", err)
		return nil, false, "", time.Time{}, false
	}
	t := time.Now()
	if blob.Timestamp > 0 {
		t = time.UnixMilli(blob.Timestamp)
	}
	return blob.Info, blob.Unsupported, blob.ErrStr, t, true
}

func (a *App) storageRedisSet(ctx context.Context, key string, info *rclone.AboutInfo, unsupported bool, errStr string, updatedAt time.Time, ttl time.Duration) {
	if a.cfg.Redis == nil {
		return
	}
	ts := updatedAt.UnixMilli()
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	}
	blob, err := json.Marshal(storageCacheBlob{
		Info:        info,
		Unsupported: unsupported,
		ErrStr:      errStr,
		Timestamp:   ts,
	})
	if err != nil {
		a.log.Warn("storage 缓存序列化失败", "key", key, "err", err)
		return
	}
	if err := a.cfg.Redis.Set(ctx, key, blob, ttl).Err(); err != nil {
		a.log.Warn("storage 缓存写入失败", "key", key, "err", err)
	}
}

// storageRefreshGated 刷新冷却控制。
func (a *App) storageRefreshGated(userID int64, msgID int) (waitSec int, gated bool) {
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	key := fmt.Sprintf("%d:%d", userID, msgID)
	if a.storageRefreshAt == nil {
		a.storageRefreshAt = map[string]time.Time{}
	}
	last, ok := a.storageRefreshAt[key]
	if !ok {
		a.storageRefreshAt[key] = time.Now()
		return 0, false
	}
	elapsed := time.Since(last)
	const window = 10 * time.Second
	if elapsed < window {
		return int((window-elapsed)/time.Second) + 1, true
	}
	a.storageRefreshAt[key] = time.Now()
	return 0, false
}

// handleStorageCommand /storage [drive_num] —— 发占位消息并后台拉取容量信息。
func (a *App) handleStorageCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	targetDriveID := ""
	if fields := strings.Fields(msg.Text); len(fields) > 1 {
		targetDriveID = strings.TrimSpace(fields[1])
	}

	placeholderID, err := a.tg.SendMessageWithID(ctx, msg.ChatID, storagePlaceholder)
	if err != nil {
		return err
	}
	go a.storageLoadAndEdit(userID, msg.ChatID, placeholderID, targetDriveID, false, 0)
	return nil
}

// handleStorageCallback 处理容量查询与刷新回调按钮。
func (a *App) handleStorageCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	targetDriveID := ""
	isRefresh := strings.HasPrefix(data, "storage_refresh")
	if strings.HasPrefix(data, "storage_check_") {
		targetDriveID = strings.TrimPrefix(data, "storage_check_")
	} else if strings.HasPrefix(data, "storage_refresh_") {
		targetDriveID = strings.TrimPrefix(data, "storage_refresh_")
	}

	if isRefresh {
		if wait, gated := a.storageRefreshGated(cb.UserID, cb.MsgID); gated {
			return a.tg.AnswerCallback(ctx, cb.CallbackID,
				fmt.Sprintf("⏳ 刷新太快了，请 %d 秒后再试", wait), false)
		}
		if err := a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, storageSyncing); err != nil {
			a.log.Warn("/storage 刷新提示编辑失败", "msgId", cb.MsgID, "err", err)
		}
		time.Sleep(storageRefreshDelay)
	}

	go a.storageLoadAndEdit(userID, cb.ChatID, cb.MsgID, targetDriveID, isRefresh, cb.CallbackID)
	return nil
}

// storageLoadAndEdit 后台查询容量、格式化并更新 Telegram 消息。
func (a *App) storageLoadAndEdit(userID string, chatID int64, msgID int, driveID string, force bool, callbackID int64) {
	defer func() {
		if r := recover(); r != nil {
			a.log.Error("storageLoadAndEdit 发生异常恢复", "panic", r)
		}
	}()

	var (
		answerText string
		answerAlert bool
	)
	if callbackID != 0 {
		defer func() {
			actx, acancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer acancel()
			if aerr := a.tg.AnswerCallback(actx, callbackID, answerText, answerAlert); aerr != nil {
				a.log.Warn("回应容量刷新按钮失败", "err", aerr)
			}
		}()
	}

	ctx, cancel := context.WithTimeout(context.Background(), storageLoadTimeout)
	defer cancel()

	drives, err := a.drivesList(ctx, userID)
	if err != nil {
		a.log.Error("/storage 读取网盘列表失败", "userId", userID, "err", err)
		_ = a.tg.EditMessage(ctx, chatID, msgID, "❌ 加载网盘信息失败，请稍后重试。")
		return
	}
	if len(drives) == 0 {
		_ = a.tg.EditWithButtons(ctx, chatID, msgID, noDriveHint, driveBindButtons())
		return
	}

	var target *drive.Drive
	if driveID != "" {
		// 优先按序号匹配（如 /storage 1）
		if idx, err := strconv.Atoi(driveID); err == nil && idx >= 1 && idx <= len(drives) {
			target = &drives[idx-1]
		} else {
			// 按 driveID 精确匹配
			for i := range drives {
				if drives[i].ID == driveID {
					target = &drives[i]
					break
				}
			}
		}
	}
	if target == nil {
		for i := range drives {
			if drives[i].IsDefault == 1 {
				target = &drives[i]
				break
			}
		}
		if target == nil {
			target = &drives[0]
		}
	}

	info, unsupported, errDetail, updatedAt, qErr := a.getDriveStorage(ctx, target, force)
	text, buttons := renderStorageView(target, info, unsupported, errDetail, drives, updatedAt)

	if len(buttons) == 0 {
		_ = a.tg.EditMessage(ctx, chatID, msgID, text)
	} else if err := a.tg.EditWithButtons(ctx, chatID, msgID, text, buttons); err != nil {
		a.log.Warn("/storage 编辑消息失败", "msgId", msgID, "err", err)
	}

	if force && qErr == nil {
		answerText = storageRefreshOK
	}
}

// getDriveStorage 读取网盘空间，带内存与 Redis 两级缓存与 Proton session lock。
func (a *App) getDriveStorage(ctx context.Context, d *drive.Drive, force bool) (*rclone.AboutInfo, bool, string, time.Time, error) {
	key := storageCacheKey(d)
	if !force {
		if info, unsupported, errStr, updatedAt, ok := a.storageMemGet(key); ok {
			return info, unsupported, errStr, updatedAt, nil
		}
		if info, unsupported, errStr, updatedAt, ok := a.storageRedisGet(ctx, key); ok {
			a.storageMemSet(key, info, unsupported, errStr, updatedAt, storageDefaultTTL)
			return info, unsupported, errStr, updatedAt, nil
		}
	}

	if a.rclone == nil {
		return nil, false, "rclone 执行器未配置", time.Time{}, errors.New("rclone 未配置")
	}

	executeAbout := func() (*rclone.AboutInfo, error) {
		cfg, harvest, bErr := a.buildRuntime(ctx, d)
		if bErr != nil {
			return nil, bErr
		}
		if cfg.Runtime != nil {
			defer cfg.Runtime.Dispose()
		}
		if harvest != nil {
			defer func() {
				if herr := harvest(); herr != nil {
					a.log.Error("收割 Proton session 失败", "err", herr)
				}
			}()
		}
		cfg.Timeout = 30 * time.Second
		return a.rclone.About(ctx, cfg)
	}

	var info *rclone.AboutInfo
	var err error

	// 仅 Proton 等需维护一次性 Session 的后端才加锁；静态网盘不锁，避免大文件上传阻塞容量查询
	if d.WritableRuntime() {
		lockKey := drive.Key(drive.Type(d.Type), d.UserID)
		err = a.locks.WithSession(ctx, lockKey, func() error {
			var qErr error
			info, qErr = executeAbout()
			return qErr
		})
	} else {
		info, err = executeAbout()
	}

	unsupported := false
	errStr := ""
	if errors.Is(err, rclone.ErrAboutNotSupported) {
		unsupported = true
		err = nil
	} else if err != nil {
		errStr = err.Error()
	}

	updatedAt := time.Now()
	// 仅成功或明确不支持配额的后端才写入缓存，避免网络偶发超时造成负向缓存中毒
	if err == nil || unsupported {
		a.storageMemSet(key, info, unsupported, errStr, updatedAt, storageDefaultTTL)
		a.storageRedisSet(ctx, key, info, unsupported, errStr, updatedAt, storageDefaultTTL)
	}
	return info, unsupported, errStr, updatedAt, err
}

func driveTypeIcon(driveType string) string {
	switch strings.ToLower(driveType) {
	case "mega":
		return "🟢"
	case "protondrive", "proton":
		return "🛡️"
	case "webdav":
		return "🌐"
	case "oss", "s3":
		return "📦"
	case "pikpak":
		return "⚡"
	case "filen":
		return "🔒"
	case "pcloud":
		return "☁️"
	default:
		return "📁"
	}
}

func renderStorageView(d *drive.Drive, info *rclone.AboutInfo, unsupported bool, errStr string, allDrives []drive.Drive, updatedAt time.Time) (string, [][]tgclient.Button) {
	var sb strings.Builder
	sb.WriteString("📊 <b>网盘空间概况</b>\n\n")

	icon := driveTypeIcon(d.Type)
	folder := "根目录 (/)"
	if d.RemoteFolder.Valid && strings.TrimSpace(d.RemoteFolder.String) != "" {
		folder = "/" + strings.Trim(d.RemoteFolder.String, "/")
	}
	account := driveDisplayAccount(d)

	typeLabel := strings.ToUpper(d.Type)
	if d.IsDefault == 1 {
		typeLabel += " (默认)"
	}
	sb.WriteString(fmt.Sprintf("%s <b>网盘类型:</b> <b>%s</b>\n", icon, typeLabel))
	sb.WriteString(fmt.Sprintf("👤 <b>账号标识:</b> <code>%s</code>\n", escapeHTMLText(account)))
	sb.WriteString(fmt.Sprintf("📂 <b>保存目录:</b> <code>%s</code>\n", escapeHTMLText(folder)))
	sb.WriteString("──────────────────\n")

	if unsupported {
		sb.WriteString("⚠️ <b>该存储类型不支持查询剩余空间配额</b>\n")
		sb.WriteString("<i>后端协议（如 S3/OSS 或部分 WebDAV 端点）未提供容量上限与用量查询接口，不影响日常文件正常转存。</i>\n")
	} else if errStr != "" {
		sb.WriteString("❌ <b>空间信息查询失败</b>\n")
		sb.WriteString(fmt.Sprintf("<code>%s</code>\n", escapeHTMLText(errStr)))
	} else if info != nil {
		if info.Total != nil && *info.Total > 0 {
			total := *info.Total
			used := int64(0)
			if info.Used != nil {
				used = *info.Used
				if used < 0 {
					used = 0
				}
			}
			free := total - used
			if info.Free != nil {
				free = *info.Free
			}
			if free < 0 {
				free = 0
			}

			usedRatio := float64(used) / float64(total)
			freeRatio := float64(free) / float64(total)

			sb.WriteString(fmt.Sprintf("📦 <b>总容量:</b> <code>%s</code>\n", formatSize(total)))
			sb.WriteString(fmt.Sprintf("📈 <b>已使用:</b> <code>%s</code> (%.1f%%)\n", formatSize(used), usedRatio*100))
			sb.WriteString(fmt.Sprintf("📉 <b>剩余可用:</b> <code>%s</code> (%.1f%%)\n", formatSize(free), freeRatio*100))
			sb.WriteString(fmt.Sprintf("📊 <b>使用率:</b> %s\n", renderProgressBar(usedRatio, 10)))

			// 智能健康状态判断
			sb.WriteString("──────────────────\n")
			switch {
			case usedRatio >= 0.95:
				sb.WriteString(fmt.Sprintf("🚨 <b>存储空间严重告急 (已用 %.1f%%)</b>\n<i>剩余容量不足 5%%，后续文件转存极易失败，请尽快扩容或清理！</i>\n", usedRatio*100))
			case usedRatio >= 0.85:
				sb.WriteString(fmt.Sprintf("⚠️ <b>存储空间偏紧 (已用 %.1f%%)</b>\n<i>剩余容量不足 15%%，建议关注空间用量。</i>\n", usedRatio*100))
			default:
				sb.WriteString("🟢 <b>空间状态充裕 (健康)</b>\n")
			}
		} else if info.Used != nil {
			sb.WriteString(fmt.Sprintf("📈 <b>已使用容量:</b> <code>%s</code>\n", formatSize(*info.Used)))
		}

		if info.Trashed != nil && *info.Trashed > 0 {
			sb.WriteString(fmt.Sprintf("🗑️ <b>回收站占用:</b> <code>%s</code>\n", formatSize(*info.Trashed)))
			if *info.Trashed >= 200*1024*1024 { // 大于 200MB 给出温馨减负提示
				sb.WriteString("💡 <i>提示: 回收站占用较多空间，可在网盘网页端彻底清空以释放容量。</i>\n")
			}
		}
		if info.Objects != nil && *info.Objects > 0 {
			sb.WriteString(fmt.Sprintf("📄 <b>对象/文件数:</b> <code>%d</code> 个\n", *info.Objects))
		}
	} else {
		sb.WriteString("暂无空间信息\n")
	}

	if !updatedAt.IsZero() {
		sb.WriteString("──────────────────\n")
		sb.WriteString(fmt.Sprintf("🕒 <i>统计时间: %s</i>\n", updatedAt.Format("15:04:05")))
	}

	buttons := [][]tgclient.Button{}

	// 操作行 1：刷新
	refreshBtn := tgclient.Button{
		Text: "🔄 刷新容量",
		Data: "storage_refresh_" + d.ID,
	}
	buttons = append(buttons, []tgclient.Button{refreshBtn})

	// 操作行 2：如果有多盘，允许快捷切换查看其它盘（每行 2 个，排版更美观、防截断）
	if len(allDrives) > 1 {
		driveRow := []tgclient.Button{}
		for i := range allDrives {
			od := &allDrives[i]
			tIcon := driveTypeIcon(od.Type)
			label := fmt.Sprintf("%s %d. %s", tIcon, i+1, strings.ToUpper(od.Type))
			if od.ID == d.ID {
				label = "👉 " + label
			} else if od.IsDefault == 1 {
				label = label + " ⭐"
			}
			driveRow = append(driveRow, tgclient.Button{
				Text: label,
				Data: "storage_check_" + od.ID,
			})
			if len(driveRow) == 2 {
				buttons = append(buttons, driveRow)
				driveRow = []tgclient.Button{}
			}
		}
		if len(driveRow) > 0 {
			buttons = append(buttons, driveRow)
		}
	}

	// 导航行：返回文件列表 / 网盘管理
	buttons = append(buttons, []tgclient.Button{
		{Text: "📁 查看文件", Data: "files_page_0"},
		{Text: "⚙️ 网盘管理", Data: "drive_manager_back"},
	})

	return sb.String(), buttons
}
