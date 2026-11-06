package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/gofile"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

const (
	gofilePageSize = 5
)

// handleGofileMessage 检测并处理包含 Gofile 资源链接的消息。
func (a *App) handleGofileMessage(ctx context.Context, msg messageInfo) bool {
	urls := gofile.ExtractGofileURLs(msg.Text)
	if len(urls) == 0 {
		return false
	}

	if a.tg != nil && a.tg.SelfID() != 0 && msg.SenderID == a.tg.SelfID() {
		return false
	}

	if !a.requireDrive(ctx, msg.ChatID, msg.SenderID) {
		return true
	}

	rawURL := urls[0]
	contentID := gofile.ExtractContentID(rawURL)
	if contentID == "" {
		return false
	}

	// 1. 消息防抖：同 Chat 同 ContentID 在 3 秒内不重复解析
	dedupKey := fmt.Sprintf("%d:%s", msg.ChatID, contentID)
	a.gofileReqMu.Lock()
	lastReq, exists := a.gofileReqs[dedupKey]
	now := time.Now()
	if exists && now.Sub(lastReq) < 3*time.Second {
		a.gofileReqMu.Unlock()
		a.log.Debug("跳过重复的 Gofile 请求(防抖触发)", "key", dedupKey)
		return true
	}
	a.gofileReqs[dedupKey] = now
	// 清理过期的防抖缓存项
	for k, t := range a.gofileReqs {
		if now.Sub(t) > 10*time.Second {
			delete(a.gofileReqs, k)
		}
	}
	a.gofileReqMu.Unlock()

	// 2. 权限校验
	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.can(ctx, userID, auth.ActionExternalLink) {
		a.log.Warn("用户无外链离线下载权限", "userId", userID)
		_ = a.notifier.SendMessage(ctx, msg.ChatID, "⛔ <b>您当前没有外部链接离线转存权限。</b>")
		return true
	}

	a.log.Info("开始解析 Gofile 资源", "url", rawURL, "contentId", contentID, "chatId", msg.ChatID)

	// 3. 调用 Gofile 客户端解析
	res, err := a.gofileClient.Resolve(ctx, contentID, "")
	if err != nil {
		a.log.Warn("Gofile 解析失败", "url", rawURL, "err", err)
		var userTip string
		switch {
		case errors.Is(err, gofile.ErrRateLimited):
			userTip = "⏳ <b>Gofile 官方服务繁忙（频率受限）</b>\n\n请在 1 分钟后重试。"
		case errors.Is(err, gofile.ErrPasswordRequired):
			userTip = "🔐 <b>该 Gofile 文件夹设有访问密码</b>\n\n暂不支持需密码保护的私密分享。"
		case errors.Is(err, gofile.ErrNotFound):
			userTip = "❌ <b>该 Gofile 资源不存在或已被作者删除</b>"
		case errors.Is(err, gofile.ErrNoMedia):
			userTip = "⚠️ <b>该文件夹中未发现可转存的媒体文件</b>"
		default:
			userTip = fmt.Sprintf("❌ <b>Gofile 解析失败</b>\n\n原因: %s", escapeHTMLText(err.Error()))
		}
		_ = a.notifier.SendMessage(ctx, msg.ChatID, userTip)
		return true
	}

	// 4. 生成交互式选择面板
	nonce := newGofileNonce()

	// 序列化文件列表以便在会话中持久化
	filesData, err := json.Marshal(res.Files)
	if err != nil {
		_ = a.notifier.SendMessage(ctx, msg.ChatID, "❌ 内部错误：文件列表处理失败。")
		return true
	}

	if a.bindSessions != nil {
		sessData := map[string]string{
			"nonce":         nonce,
			"chat_id":       fmt.Sprintf("%d", msg.ChatID),
			"content_id":    res.ID,
			"folder_name":   res.Name,
			"account_token": res.AccountToken,
			"page":          "0",
			"files":         string(filesData),
			"queued":        "",
		}
		if err := a.bindSessions.Start(ctx, userID, "GOFILE_SELECT", sessData); err != nil {
			a.log.Warn("保存 Gofile 交互会话失败", "err", err)
			_ = a.notifier.SendMessage(ctx, msg.ChatID, "❌ 会话初始化失败，请稍后重试。")
			return true
		}
	}

	// 5. 渲染首页面板
	text, buttons := renderGofileFolderView(res.Name, res.Files, 0, nonce, nil)
	_ = a.tg.SendWithButtons(ctx, msg.ChatID, text, buttons)
	return true
}

func newGofileNonce() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func parseQueuedIDs(raw string) map[string]bool {
	m := make(map[string]bool)
	if raw == "" {
		return m
	}
	for _, id := range strings.Split(raw, ",") {
		id = strings.TrimSpace(id)
		if id != "" {
			m[id] = true
		}
	}
	return m
}

func encodeQueuedIDs(m map[string]bool) string {
	var list []string
	for id, ok := range m {
		if ok {
			list = append(list, id)
		}
	}
	sort.Strings(list)
	return strings.Join(list, ",")
}

func renderGofileFolderView(folderName string, files []gofile.FileItem, page int, nonce string, queued map[string]bool) (string, [][]tgclient.Button) {
	if queued == nil {
		queued = make(map[string]bool)
	}
	totalFiles := len(files)
	var totalBytes int64
	for _, f := range files {
		totalBytes += f.Size
	}

	totalPages := (totalFiles + gofilePageSize - 1) / gofilePageSize
	if totalPages == 0 {
		totalPages = 1
	}
	if page < 0 {
		page = 0
	}
	if page >= totalPages {
		page = totalPages - 1
	}

	start := page * gofilePageSize
	end := start + gofilePageSize
	if end > totalFiles {
		end = totalFiles
	}

	pageFiles := files[start:end]

	var sb strings.Builder
	dispName := folderName
	if dispName == "" {
		dispName = "未命名文件夹"
	}
	sb.WriteString(fmt.Sprintf("📁 <b>Gofile 资源文件夹: %s</b>\n", escapeHTMLText(dispName)))
	sb.WriteString(fmt.Sprintf("📊 包含 <code>%d</code> 个文件 | 总容量: <code>%s</code>\n", totalFiles, formatBytes(totalBytes)))

	queuedCount := len(queued)
	if queuedCount > 0 {
		var queuedBytes int64
		for _, f := range files {
			if queued[f.ID] {
				queuedBytes += f.Size
			}
		}
		sb.WriteString(fmt.Sprintf("📥 <b>已提交转存:</b> <code>%d</code> 个文件 (%s)\n", queuedCount, formatBytes(queuedBytes)))
	}
	sb.WriteString("⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n")

	for i, f := range pageFiles {
		globalIdx := start + i + 1
		isQueued := queued[f.ID]
		icon := "🎬"
		statusTag := ""
		if isQueued {
			icon = "✅"
			statusTag = " <i>[已提交]</i>"
		}
		sb.WriteString(fmt.Sprintf("%s <b>%d.</b> <code>%s</code> (%s)%s\n",
			icon,
			globalIdx,
			escapeHTMLText(shortenRunes(f.Name, 24)),
			formatBytes(f.Size),
			statusTag,
		))
	}
	sb.WriteString("⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n")
	sb.WriteString(fmt.Sprintf("📄 <i>第 <b>%d</b> / <b>%d</b> 页</i>\n", page+1, totalPages))
	if queuedCount > 0 {
		sb.WriteString("💡 <i>提示: 点击未提交文件可继续添加；选完请点击「完成选择」或直接关闭。</i>")
	} else {
		sb.WriteString("💡 <i>提示: 可点选单个/多个文件转存，或点击「全部转存」。</i>")
	}

	var buttons [][]tgclient.Button

	// 1. 当前页的文件按钮（支持连续点选，已提交的显示标记）
	for i, f := range pageFiles {
		globalIdx := start + i
		isQueued := queued[f.ID]
		var btnText string
		if isQueued {
			btnText = fmt.Sprintf("✅ %d. %s (已提交)", start+i+1, shortenRunes(f.Name, 15))
		} else {
			btnText = fmt.Sprintf("%d. %s (%s)", start+i+1, shortenRunes(f.Name, 18), formatBytes(f.Size))
		}
		buttons = append(buttons, []tgclient.Button{
			{Text: btnText, Data: fmt.Sprintf("gofile_pick_%d_%s", globalIdx, nonce)},
		})
	}

	// 2. 分页导航按钮（多于 1 页时显示）
	if totalPages > 1 {
		var navRow []tgclient.Button
		if page > 0 {
			navRow = append(navRow, tgclient.Button{
				Text: "◀️ 上一页",
				Data: fmt.Sprintf("gofile_page_%d_%s", page-1, nonce),
			})
		}
		navRow = append(navRow, tgclient.Button{
			Text: fmt.Sprintf("· %d / %d ·", page+1, totalPages),
			Data: fmt.Sprintf("gofile_noop_%s", nonce),
		})
		if page < totalPages-1 {
			navRow = append(navRow, tgclient.Button{
				Text: "下一页 ▶️",
				Data: fmt.Sprintf("gofile_page_%d_%s", page+1, nonce),
			})
		}
		buttons = append(buttons, navRow)
	}

	// 3. 批量转存操作行
	if queuedCount < totalFiles {
		remainingCount := totalFiles - queuedCount
		var remainingBytes int64
		for _, f := range files {
			if !queued[f.ID] {
				remainingBytes += f.Size
			}
		}
		var allText string
		if queuedCount == 0 {
			allText = fmt.Sprintf("📥 全部转存 (%d 个文件 / %s)", totalFiles, formatBytes(totalBytes))
		} else {
			allText = fmt.Sprintf("📥 转存剩余全部 (%d 个文件 / %s)", remainingCount, formatBytes(remainingBytes))
		}
		buttons = append(buttons, []tgclient.Button{
			{
				Text: allText,
				Data: "gofile_all_" + nonce,
			},
		})
	}

	// 4. 退出 / 完成操作行
	if queuedCount > 0 {
		buttons = append(buttons, []tgclient.Button{
			{Text: fmt.Sprintf("✅ 完成选择 (%d)", queuedCount), Data: "gofile_done_" + nonce},
			{Text: "❌ 关闭面板", Data: "gofile_cancel_" + nonce},
		})
	} else {
		buttons = append(buttons, []tgclient.Button{
			{Text: "❌ 取消", Data: "gofile_cancel_" + nonce},
		})
	}

	return sb.String(), buttons
}

// handleGofileCallback 统一处理 Gofile 交互按钮回调。
func (a *App) handleGofileCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应 Gofile 按钮失败", "err", err)
		}
	}

	if a.bindSessions == nil {
		answer("会话存储不可用", true)
		return nil
	}

	sess, err := a.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil || sess.CurrentStep != "GOFILE_SELECT" {
		answer("操作已失效或已被处理", true)
		return nil
	}

	expectedNonce := sess.Data["nonce"]
	if expectedNonce == "" || !strings.HasSuffix(data, expectedNonce) {
		answer("操作已失效或已被处理", true)
		return nil
	}

	folderName := sess.Data["folder_name"]
	accountToken := sess.Data["account_token"]
	var files []gofile.FileItem
	if err := json.Unmarshal([]byte(sess.Data["files"]), &files); err != nil || len(files) == 0 {
		_ = a.bindSessions.Clear(ctx, userID)
		answer("会话数据损坏，请重新发送链接", true)
		return nil
	}

	queued := parseQueuedIDs(sess.Data["queued"])

	// 分支 A：取消 / 关闭面板
	if strings.HasPrefix(data, "gofile_cancel_") {
		_ = a.bindSessions.Clear(ctx, userID)
		if len(queued) > 0 {
			answer("已关闭面板", false)
			_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, fmt.Sprintf(
				"✅ <b>Gofile 文件选择已结束</b>\n\n📁 文件夹: <code>%s</code>\n已提交的 <code>%d 个文件</code> 正在后台正常处理中。",
				escapeHTMLText(folderName), len(queued),
			))
		} else {
			answer("已取消转存", false)
			_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, "🚫 <b>已取消 Gofile 文件转存。</b>")
		}
		return nil
	}

	// 分支 B：完成选择
	if strings.HasPrefix(data, "gofile_done_") {
		_ = a.bindSessions.Clear(ctx, userID)
		var totalQueuedBytes int64
		for _, f := range files {
			if queued[f.ID] {
				totalQueuedBytes += f.Size
			}
		}
		answer("已完成转存配置", false)
		_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, fmt.Sprintf(
			"🎉 <b>Gofile 转存任务已创建</b>\n\n📁 文件夹: <code>%s</code>\n📥 已提交转存: <code>%d 个文件</code> (%s)\n\n后台正在排队下载并同步至您的网盘，完成后将发送通知。",
			escapeHTMLText(folderName), len(queued), formatBytes(totalQueuedBytes),
		))
		return nil
	}

	// 分支 C：当前页码指示（防重复编辑）
	if strings.HasPrefix(data, "gofile_noop_") {
		currentPage, _ := strconv.Atoi(sess.Data["page"])
		totalPages := (len(files) + gofilePageSize - 1) / gofilePageSize
		if totalPages == 0 {
			totalPages = 1
		}
		answer(fmt.Sprintf("当前为第 %d / %d 页", currentPage+1, totalPages), false)
		return nil
	}

	// 分支 D：翻页
	if strings.HasPrefix(data, "gofile_page_") {
		// gofile_page_{page}_{nonce}
		parts := strings.Split(data, "_")
		if len(parts) >= 4 {
			newPage, _ := strconv.Atoi(parts[2])
			sess.Data["page"] = strconv.Itoa(newPage)
			_ = a.bindSessions.Update(ctx, userID, "GOFILE_SELECT", sess.Data)
			text, buttons := renderGofileFolderView(folderName, files, newPage, expectedNonce, queued)
			_ = a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
			answer("", false)
			return nil
		}
	}

	// 分支 E：单文件点选转存（连续多选不消失！）
	if strings.HasPrefix(data, "gofile_pick_") {
		parts := strings.Split(data, "_")
		if len(parts) < 4 {
			answer("参数错误", true)
			return nil
		}
		idx, err := strconv.Atoi(parts[2])
		if err != nil || idx < 0 || idx >= len(files) {
			answer("文件索引无效", true)
			return nil
		}
		target := files[idx]

		// 检查是否已经在队列中
		if queued[target.ID] {
			answer(fmt.Sprintf("ℹ️「%s」已在转存队列中", shortenRunes(target.Name, 16)), false)
			return nil
		}

		// 权限二次检查
		if !a.can(ctx, userID, auth.ActionExternalLink) {
			answer("无权执行此操作", true)
			return nil
		}

		// 容量预检
		if a.storage != nil {
			if err := a.storage.AssertCapacity(a.cfg.DownloadDir, target.Size, fmt.Sprintf("gofile %s", target.Name)); err != nil {
				answer(fmt.Sprintf("⚠️ 磁盘空间不足: 需要 %s", formatBytes(target.Size)), true)
				return nil
			}
		}

		// 立即排队入库
		a.enqueueGofileItem(ctx, userID, cb.ChatID, cb.MsgID, target, accountToken, true)

		// 标记该文件已入队并持久化会话
		queued[target.ID] = true
		sess.Data["queued"] = encodeQueuedIDs(queued)
		_ = a.bindSessions.Update(ctx, userID, "GOFILE_SELECT", sess.Data)

		currentPage, _ := strconv.Atoi(sess.Data["page"])
		text, buttons := renderGofileFolderView(folderName, files, currentPage, expectedNonce, queued)
		_ = a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)

		answer(fmt.Sprintf("✅ 已加入队列: %s", shortenRunes(target.Name, 16)), false)
		return nil
	}

	// 分支 F：全部转存（或转存剩余全部）
	if strings.HasPrefix(data, "gofile_all_") {
		// 权限二次检查
		if !a.can(ctx, userID, auth.ActionExternalLink) {
			answer("无权执行此操作", true)
			return nil
		}

		var remaining []gofile.FileItem
		var remainingBytes int64
		for _, f := range files {
			if !queued[f.ID] {
				remaining = append(remaining, f)
				remainingBytes += f.Size
			}
		}

		if len(remaining) == 0 {
			answer("所有文件均已在转存队列中", false)
			return nil
		}

		// 容量预检
		if a.storage != nil {
			if err := a.storage.AssertCapacity(a.cfg.DownloadDir, remainingBytes, fmt.Sprintf("gofile all %s", folderName)); err != nil {
				answer(fmt.Sprintf("⚠️ 磁盘空间不足: 需要 %s", formatBytes(remainingBytes)), true)
				return nil
			}
		}

		// 全部转存成功后清理会话
		_ = a.bindSessions.Clear(ctx, userID)

		withNotice := len(remaining) <= 3
		for _, item := range remaining {
			a.enqueueGofileItem(ctx, userID, cb.ChatID, cb.MsgID, item, accountToken, withNotice)
		}

		var totalBytes int64
		for _, f := range files {
			totalBytes += f.Size
		}

		answer(fmt.Sprintf("已将剩余 %d 个文件加入队列", len(remaining)), false)
		_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, fmt.Sprintf(
			"✅ <b>已将全部文件加入转存队列</b>\n\n📁 文件夹: <code>%s</code>\n📊 数量: <code>%d 个文件</code>\n📦 总容量: <code>%s</code>\n\n正在排队依次下载并同步至您的网盘...",
			escapeHTMLText(folderName), len(files), formatBytes(totalBytes),
		))
		return nil
	}

	answer("未知的操作", false)
	return nil
}

func (a *App) enqueueGofileItem(ctx context.Context, userID string, chatID int64, srcMsgID int, item gofile.FileItem, token string, withNotice bool) {
	taskID := newTaskID()
	var noticeID int
	if withNotice {
		noticeID = a.postNotice(ctx, chatID, taskID)
	}

	headers := make(map[string]string)
	if token != "" {
		headers["Cookie"] = "accountToken=" + token
		headers["Authorization"] = "Bearer " + token
	}

	refData, _ := json.Marshal(externalSourceRef{
		URL:      item.Link,
		WebURL:   item.Link,
		Platform: "gofile",
		Headers:  headers,
	})

	t := store.Task{
		ID:          taskID,
		UserID:      userID,
		ChatID:      nullableString(fmt.Sprintf("%d", chatID)),
		SourceType:  "external_url",
		FileName:    nullableString(item.Name),
		FileSize:    item.Size,
		SourceRef:   nullableString(string(refData)),
		MsgID:       nullableInt(int64(noticeID)),
		SourceMsgID: nullableInt(int64(srcMsgID)),
	}

	if err := a.repo.Create(ctx, t); err != nil {
		a.log.Error("创建 Gofile 转存任务失败", "taskId", taskID, "err", err)
		return
	}

	a.enqueue(ctx, taskID)
	a.log.Info("已创建 Gofile 转存任务", "taskId", taskID, "file", item.Name, "size", item.Size)
}
