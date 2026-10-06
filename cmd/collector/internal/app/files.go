package app

// /files —— 远端目录浏览。
//
// 对应 JS 侧 Dispatcher._handleFilesCommand + UIHelper.renderFilesPage。
// 文案与 JS 逐字一致:切换期两边可能同时在跑,用户看到的应该是同一句话。
//
// 刻意不做缓存(JS 侧有内存+KV 两级、按文件变化频率动态调 TTL):
// /files 是低频操作,每次真拉一次 lsjson 就够,省下约 80 行缓存代码。
// ponytail: 无缓存,若 /files 变成高频操作再按 JS 的 TTL 策略补。

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// filesPageSize 每页条数 —— 与 JS renderFilesPage 的默认一致。
const filesPageSize = 6

// filesLoadFailed 与 JS 侧 STRINGS.files.load_failed 一致。
const filesLoadFailed = "❌ <b>无法获取文件列表</b>\n\n请重新加载；如果连续失败，请联系管理员。"

// filesDirEmpty 与 JS 侧 STRINGS.files.dir_empty 一致。
const filesDirEmpty = "ℹ️ 目录为空。您可以直接发送文件给我，将其转存到此目录。"

// handleFilesCommand /files —— 列默认盘保存目录的第一页。
func (a *App) handleFilesCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	text, buttons, err := a.filesView(ctx, userID, 0)
	if err != nil {
		a.log.Error("/files 加载失败", "userId", userID, "err", err)
		return a.tg.SendMessage(ctx, msg.ChatID, filesLoadFailed)
	}
	if len(buttons) == 0 {
		return a.tg.SendMessage(ctx, msg.ChatID, text)
	}
	return a.tg.SendWithButtons(ctx, msg.ChatID, text, buttons)
}

// handleFilesCallback 翻页/刷新 —— 在同一条消息上重绘。
func (a *App) handleFilesCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	page, ok := filesPageOf(data)
	if !ok {
		return nil
	}
	text, buttons, err := a.filesView(ctx, fmt.Sprintf("%d", cb.UserID), page)
	if err != nil {
		a.log.Error("/files 翻页加载失败", "userId", cb.UserID, "page", page, "err", err)
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, filesLoadFailed)
	}
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// filesPageOf 从按钮 payload 里解析目标页码。
func filesPageOf(data string) (int, bool) {
	prefix := ""
	switch {
	case strings.HasPrefix(data, "files_page_"):
		prefix = "files_page_"
	case strings.HasPrefix(data, "files_refresh_"):
		prefix = "files_refresh_"
	default:
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(data, prefix))
	if err != nil || n < 0 {
		return 0, true
	}
	return n, true
}

// filesView 取清单并渲染一页。没绑盘/没配仓储不算错误 —— 返回提示文案。
func (a *App) filesView(ctx context.Context, userID string, page int) (string, [][]tgclient.Button, error) {
	if a.drives == nil {
		return "⚠️ 文件列表在新服务上暂不可用,请稍后再试或联系管理员。", nil, nil
	}
	d, err := a.drives.DefaultDrive(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	if d == nil {
		return noDriveHint, nil, nil
	}
	files, err := a.listFiles(ctx, d)
	if err != nil {
		return "", nil, err
	}
	text, buttons := renderFilesPage(d.RemotePath(a.cfg.RemoteBase), files, page)
	return text, buttons, nil
}

// listFiles 拉某盘保存目录的清单。
//
// Proton 的 list 也会消耗 session(记忆 proton-refresh-token-race:
// PR#446 把 probe/list 侧门收进了可写 runtime),所以必须与上传同等待遇:
// 进程内会话锁 + 跑完收割写回。少任何一样,一次 /files 就可能把
// 账号砖化 —— 而「只是看了看文件列表」的用户什么都没做错。
func (a *App) listFiles(ctx context.Context, d *drive.Drive) ([]rclone.FileEntry, error) {
	remote := d.RemotePath(a.cfg.RemoteBase)
	key := drive.Key(drive.Type(d.Type), d.UserID)
	var files []rclone.FileEntry
	err := a.locks.WithSession(ctx, key, func() error {
		cfg, harvest, err := a.buildRuntime(ctx, d)
		if err != nil {
			return err
		}
		cfg.Timeout = 30 * time.Second
		files, err = a.rclone.ListFiles(ctx, cfg, remote)
		// 收割与成败无关:lsjson 失败也可能已经旋转过 token,
		// 不写回就等于把它扔了。
		if harvest != nil {
			if herr := harvest(); herr != nil {
				a.log.Error("收割 Proton session 失败,下次操作可能因 token 过期而失败", "err", herr)
			}
		}
		return err
	})
	return files, err
}

// renderFilesPage 渲染一页文件清单(纯函数,好测)。
func renderFilesPage(folder string, files []rclone.FileEntry, page int) (string, [][]tgclient.Button) {
	// 目录在前、文件按修改时间倒序 —— 与 JS listRemoteFiles 的排序一致。
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].IsDir != files[j].IsDir {
			return files[i].IsDir
		}
		return modTimeOf(files[i].ModTime).After(modTimeOf(files[j].ModTime))
	})

	totalPages := (len(files) + filesPageSize - 1) / filesPageSize
	if totalPages == 0 {
		totalPages = 1
	}
	if page < 0 {
		page = 0
	}
	if page >= totalPages {
		page = totalPages - 1
	}

	var b strings.Builder
	b.WriteString("📂 <b>目录</b>: <code>" + escapeHTMLText(folder) + "</code>\n\n")
	if len(files) == 0 {
		b.WriteString(filesDirEmpty)
	} else {
		end := min((page+1)*filesPageSize, len(files))
		for _, f := range files[page*filesPageSize : end] {
			fmt.Fprintf(&b, "%s <b>%s</b>\n    <code>%s</code> | <code>%s</code>\n\n",
				fileEmoji(f.Name),
				escapeHTMLText(shortenRunes(f.Name, 36)),
				formatSize(f.Size),
				displayModTime(f.ModTime))
		}
	}
	fmt.Fprintf(&b, "⎯⎯⎯⎯⎯⎯⎯⎯⎯\n📊 <i>第 %d/%d 页 | 共 %d 个文件</i>",
		page+1, totalPages, len(files))

	// 翻页行 —— 与 JS _buildPaginationRow 同布局。
	last := totalPages - 1
	var row []tgclient.Button
	if page > 0 {
		row = append(row,
			tgclient.Button{Text: "⏮️ 首页", Data: "files_page_0"},
			tgclient.Button{Text: "⬅️ 上一页", Data: fmt.Sprintf("files_page_%d", page-1)},
		)
	}
	row = append(row, tgclient.Button{Text: "🔄 刷新", Data: fmt.Sprintf("files_refresh_%d", page)})
	if page < last {
		row = append(row,
			tgclient.Button{Text: "➡️ 下一页", Data: fmt.Sprintf("files_page_%d", page+1)},
			tgclient.Button{Text: "⏭️ 末页", Data: fmt.Sprintf("files_page_%d", last)},
		)
	}
	return b.String(), [][]tgclient.Button{row}
}

// modTimeOf 解析 lsjson 的 ModTime;解析不了给零值(排在最后)。
func modTimeOf(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// displayModTime "2026-10-01T05:06:07Z" → "2026-10-01 05:06" —— 与 JS 同款截断。
func displayModTime(s string) string {
	s = strings.Replace(s, "T", " ", 1)
	if len(s) > 16 {
		return s[:16]
	}
	return s
}

// shortenRunes 按字符截断(不是字节)—— 字节截断会把一个 UTF-8 字符
// 劈成两半,Telegram 那头显示成乱码。
func shortenRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

// fileEmoji 按扩展名配图标 —— 与 JS renderFilesPage 的映射一致。
func fileEmoji(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".mp4", ".mkv", ".avi", ".mov", ".flv", ".webm":
		return "🎞️"
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp":
		return "🖼️"
	case ".mp3", ".wav", ".flac", ".m4a", ".ogg":
		return "🎵"
	case ".zip", ".rar", ".7z", ".tar", ".gz":
		return "📦"
	case ".pdf", ".epub", ".txt", ".md", ".docx", ".xlsx", ".pptx":
		return "📝"
	default:
		return "📄"
	}
}
