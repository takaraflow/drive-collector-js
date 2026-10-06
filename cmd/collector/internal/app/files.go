package app

// /files —— 远端目录浏览。
//
// 逐项对应 JS 侧 Dispatcher._handleFilesCommand / _handleFilesCallback /
// CloudTool.listRemoteFiles / UIHelper.renderFilesPage,不许阉割:
//   - 占位消息先发、拉完再编辑(慢盘上用户立刻看到「正在加载」)
//   - 两级缓存:内存 + Redis,key 与 JS 同格式,切换期两边互通
//   - 过期时间按文件变化频率动态算(见 optimalFilesTTL)
//   - 刷新 10 秒冷却、刷新先换「同步中」提示、50ms 防抖
//   - 失败给「重新加载」按钮;没绑盘给绑定入口
// 文案与 JS 逐字一致:切换期两边可能同时在跑,用户看到的应该是同一句话。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

const (
	// filesPageSize 每页条数 —— 与 JS renderFilesPage 的默认一致。
	filesPageSize = 6
	// filesRefreshCooldown 是刷新按钮的冷却窗口(与 JS 侧 10000ms 一致)。
	filesRefreshCooldown = 10 * time.Second
	// filesRefreshDelay 是刷新前的防抖等待(与 JS getFilesRefreshDelayMs 一致,
	// 那边 test 环境为 0,生产 50ms)。
	filesRefreshDelay = 50 * time.Millisecond
)

// 文案与 JS 侧 STRINGS.files / STRINGS.drive 逐字一致。
const (
	filesPlaceholder = "📂 正在加载文件列表..."
	filesSyncing     = "🔄 正在同步最新数据..."
	filesLoadFailed  = "❌ <b>无法获取文件列表</b>\n\n请重新加载；如果连续失败，请联系管理员。"
	filesDirEmpty    = "ℹ️ 目录为空。您可以直接发送文件给我，将其转存到此目录。"
	filesRefreshOK   = "刷新成功"
)

// filesLoadTimeout 兜底整个「拉清单+渲染+编辑」的后台流程。
const filesLoadTimeout = 60 * time.Second

// handleFilesCommand /files —— 先发占位消息,再后台拉清单并编辑它。
//
// 占位消息先发、不等网盘检查:慢盘上 lsjson 要好几秒,先让用户看到
// 「正在加载」比什么都没有强(JS 侧注释里同款取舍)。
func (a *App) handleFilesCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	placeholderID, err := a.tg.SendMessageWithID(ctx, msg.ChatID, filesPlaceholder)
	if err != nil {
		return err
	}
	// 拉清单可能要几十秒,不能占着 update 循环 —— 后台做完再编辑占位消息。
	go a.filesLoadAndEdit(userID, msg.ChatID, placeholderID, 0, false, 0)
	return nil
}

// handleFilesCallback 翻页/刷新按钮 —— 与 JS _handleFilesCallback 一致。
func (a *App) handleFilesCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	page, ok := filesPageOf(data)
	if !ok {
		return nil
	}
	isRefresh := strings.HasPrefix(data, "files_refresh_")

	if isRefresh {
		// 冷却检查先于一切 —— 被限流的点击连「同步中」都不换。
		if wait, gated := a.filesRefreshGated(cb.UserID, cb.MsgID); gated {
			return a.tg.AnswerCallback(ctx, cb.CallbackID,
				fmt.Sprintf("🕒 刷新太快了，请 %d 秒后再试", wait), false)
		}
		// 先换上「同步中」,让用户知道点击生效了 —— 刷新是强制重拉,要等。
		if err := a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, filesSyncing); err != nil {
			a.log.Warn("/files 刷新提示编辑失败", "msgId", cb.MsgID, "err", err)
		}
		time.Sleep(filesRefreshDelay)
	}

	go a.filesLoadAndEdit(fmt.Sprintf("%d", cb.UserID), cb.ChatID, cb.MsgID,
		page, isRefresh, cb.CallbackID)
	return nil
}

// filesLoadAndEdit 拉清单、渲染、编辑到同一条消息上 —— 命令与按钮共用的主流程。
//
// 回执在流程末尾答(与 JS 一致):成功的刷新答「刷新成功」,其余答空;
// 失败答空(失败信息已经在消息正文里了)。callbackID 为 0 表示命令路径,不答。
func (a *App) filesLoadAndEdit(userID string, chatID int64, msgID, page int, force bool, callbackID int64) {
	// 不复用调用方的 ctx:这里在后台跑,调用方返回后那个 ctx 随时会被取消。
	ctx, cancel := context.WithTimeout(context.Background(), filesLoadTimeout)
	defer cancel()

	text, buttons, err := a.filesView(ctx, userID, page, force)
	if err != nil {
		a.log.Error("/files 加载失败", "userId", userID, "err", err)
		text, buttons = filesLoadFailed, [][]tgclient.Button{{
			{Text: "重新加载文件列表", Data: fmt.Sprintf("files_refresh_%d", page)},
		}}
	} else if text == noDriveHint {
		// 没绑盘:给绑定入口,别让用户死在这条消息里。
		buttons = [][]tgclient.Button{
			{{Text: "🟢 Mega", Data: "drive_bind_mega"}},
			{{Text: "🛡️ Proton Drive", Data: "drive_bind_protondrive"}},
		}
	}

	if len(buttons) == 0 {
		_ = a.tg.EditMessage(ctx, chatID, msgID, text)
	} else if err := a.tg.EditWithButtons(ctx, chatID, msgID, text, buttons); err != nil {
		a.log.Warn("/files 编辑消息失败", "msgId", msgID, "err", err)
	}

	if callbackID != 0 {
		answer := ""
		if err == nil && force {
			answer = filesRefreshOK
		}
		if aerr := a.tg.AnswerCallback(ctx, callbackID, answer, false); aerr != nil {
			a.log.Warn("回应按钮失败", "err", aerr)
		}
	}
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
func (a *App) filesView(ctx context.Context, userID string, page int, force bool) (string, [][]tgclient.Button, error) {
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
	files, err := a.listFiles(ctx, d, force)
	if err != nil {
		return "", nil, err
	}
	text, buttons := renderFilesPage(d.RemotePath(a.cfg.RemoteBase), files, page)
	return text, buttons, nil
}

// listFiles 取清单,带两级缓存 —— 对应 JS CloudTool.listRemoteFiles。
//
// 内存层挡本进程的翻页连击,Redis 层挡重启和另一实现(JS 侧)的重复
// 拉取;都未命中才真跑 rclone。force(刷新)两层都绕过。
func (a *App) listFiles(ctx context.Context, d *drive.Drive, force bool) ([]rclone.FileEntry, error) {
	key := filesCacheKey(d)
	if !force {
		if files, ok := a.filesMemGet(key); ok {
			return files, nil
		}
		if files, ok := a.filesRedisGet(ctx, key); ok {
			// 回填内存层,过期时间按清单新鲜度重算 —— 与 JS 一致。
			a.filesMemSet(key, files, optimalFilesTTL(files))
			return files, nil
		}
	}

	files, err := a.fetchRemoteFiles(ctx, d)
	if err != nil {
		return nil, err
	}
	ttl := optimalFilesTTL(files)
	a.filesMemSet(key, files, ttl)
	a.filesRedisSet(ctx, key, d.UserID, files, ttl)
	return files, nil
}

// fetchRemoteFiles 真跑一次 lsjson。
//
// Proton 的 list 也会消耗 session(记忆 proton-refresh-token-race:
// PR#446 把 probe/list 侧门收进了可写 runtime),所以必须与上传同等待遇:
// 进程内会话锁 + 跑完收割写回。少任何一样,一次 /files 就可能把
// 账号砖化 —— 而「只是看了看文件列表」的用户什么都没做错。
func (a *App) fetchRemoteFiles(ctx context.Context, d *drive.Drive) ([]rclone.FileEntry, error) {
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
		// 目录还没建过(新绑定、没传过东西):顺手建一次再试 —— 与 JS
		// listRemoteFiles 一致。mkdir 本来就是上传链路的第一步,这里只是
		// 把它提前到用户第一次查看。
		if errors.Is(err, rclone.ErrDirNotFound) {
			if mkErr := a.rclone.Mkdir(ctx, cfg, remote); mkErr == nil {
				files, err = a.rclone.ListFiles(ctx, cfg, remote)
			}
			if errors.Is(err, rclone.ErrDirNotFound) {
				// 建完还看不到:有的后端要等一会儿才可见。不算错,当空目录
				// —— 与 JS 一致,用户不该为「还没传过东西」吃一个错误。
				files, err = nil, nil
			}
		}
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

// filesCacheKey 与 JS CACHE_KEYS.filesByDrive 同格式 —— 切换期两边
// 读写同一个键,共同省下 rclone 调用。
func filesCacheKey(d *drive.Drive) string {
	id := d.ID
	if id == "" {
		id = d.Type
	}
	folder := ""
	if d.RemoteFolder.Valid {
		folder = d.RemoteFolder.String
	}
	return fmt.Sprintf("files_%s_%s_%s", d.UserID, id, folder)
}

// filesCacheBlob 是 Redis 层的存储形状 —— 与 JS 侧写入的 {files,
// timestamp, userId} 逐字段一致,JS 读得到 Go 写的,Go 也读得到 JS 写的。
type filesCacheBlob struct {
	Files     []rclone.FileEntry `json:"files"`
	Timestamp int64              `json:"timestamp"`
	UserID    string             `json:"userId"`
}

func (a *App) filesMemGet(key string) ([]rclone.FileEntry, bool) {
	a.filesMu.Lock()
	defer a.filesMu.Unlock()
	e, ok := a.filesMem[key]
	if !ok || time.Now().After(e.expires) {
		return nil, false
	}
	return e.files, true
}

func (a *App) filesMemSet(key string, files []rclone.FileEntry, ttl time.Duration) {
	a.filesMu.Lock()
	defer a.filesMu.Unlock()
	if a.filesMem == nil {
		a.filesMem = map[string]filesMemEntry{}
	}
	a.filesMem[key] = filesMemEntry{files: files, expires: time.Now().Add(ttl)}
}

func (a *App) filesRedisGet(ctx context.Context, key string) ([]rclone.FileEntry, bool) {
	if a.cfg.Redis == nil {
		return nil, false
	}
	raw, err := a.cfg.Redis.Get(ctx, key).Result()
	if err != nil {
		// redis.Nil(键不存在)是常态,别的错误记日志 —— 缓存挂了
		// 不该静默,排查「每次都慢」时这是第一个该看的地方。
		if err != redis.Nil {
			a.log.Warn("files 缓存读取失败", "key", key, "err", err)
		}
		return nil, false
	}
	var blob filesCacheBlob
	if err := json.Unmarshal([]byte(raw), &blob); err != nil {
		a.log.Warn("files 缓存内容无法解析,当未命中", "key", key, "err", err)
		return nil, false
	}
	return blob.Files, true
}

func (a *App) filesRedisSet(ctx context.Context, key, userID string, files []rclone.FileEntry, ttl time.Duration) {
	if a.cfg.Redis == nil {
		return
	}
	blob, err := json.Marshal(filesCacheBlob{Files: files, Timestamp: time.Now().UnixMilli(), UserID: userID})
	if err != nil {
		a.log.Warn("files 缓存序列化失败", "key", key, "err", err)
		return
	}
	// KV 至少 10 分钟 —— 与 JS 侧 Math.max(600, ttl/1000) 一致。
	kvTTL := time.Duration(max(600, int(ttl/time.Second))) * time.Second
	if err := a.cfg.Redis.Set(ctx, key, blob, kvTTL).Err(); err != nil {
		a.log.Warn("files 缓存写入失败", "key", key, "err", err)
	}
}

// filesRefreshGated 刷新冷却 —— 与 JS filesRefreshTimes 一致:
// key 是 "<user>:<msgID>",10 秒窗口内只放一次,被限流不更新时间戳。
func (a *App) filesRefreshGated(userID int64, msgID int) (waitSec int, gated bool) {
	a.filesMu.Lock()
	defer a.filesMu.Unlock()
	key := fmt.Sprintf("%d:%d", userID, msgID)
	if a.filesRefreshAt == nil {
		a.filesRefreshAt = map[string]time.Time{}
	}
	now := time.Now()
	if last, ok := a.filesRefreshAt[key]; ok && now.Sub(last) < filesRefreshCooldown {
		// 向上取整成「还差几秒」—— JS 侧 Math.ceil 同款,显示 0 秒很难看。
		remaining := last.Add(filesRefreshCooldown).Sub(now)
		return int((remaining + time.Second - 1) / time.Second), true
	}
	a.filesRefreshAt[key] = now
	return 0, false
}

// optimalFilesTTL 按文件变化频率动态算缓存时间 —— 逐分支对应 JS 的
// _calculateOptimalCacheTime:空目录 5 分钟,文件少 15 分钟,然后按
// 最近 7 天文件的平均修改间隔分档(高频 2 分钟 → 低频 1 小时)。
func optimalFilesTTL(files []rclone.FileEntry) time.Duration {
	if len(files) == 0 {
		return 5 * time.Minute
	}
	now := time.Now()
	var recent []time.Time
	for _, f := range files {
		if f.IsDir {
			continue
		}
		t := modTimeOf(f.ModTime)
		if t.IsZero() {
			continue
		}
		if now.Sub(t) < 7*24*time.Hour {
			recent = append(recent, t)
		}
	}
	if len(recent) < 2 {
		return 15 * time.Minute
	}
	sort.Slice(recent, func(i, j int) bool { return recent[i].After(recent[j]) })
	var total time.Duration
	for i := 1; i < len(recent); i++ {
		total += recent[i-1].Sub(recent[i])
	}
	avg := total / time.Duration(len(recent)-1)
	switch {
	case avg < time.Minute:
		return 2 * time.Minute
	case avg < time.Hour:
		return 5 * time.Minute
	case avg < 24*time.Hour:
		return 30 * time.Minute
	default:
		return time.Hour
	}
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
