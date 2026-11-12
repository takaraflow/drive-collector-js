package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/shortshare"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

func newShortshareNonce() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// handleShortshareMessage 拦截并处理包含 lurl.cc / myppt.cc 短链的消息。
func (a *App) handleShortshareMessage(ctx context.Context, msg messageInfo) bool {
	if a.shortshareClient == nil {
		return false
	}
	urls := shortshare.ExtractShortshareURLs(msg.Text)
	if len(urls) == 0 {
		return false
	}

	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.requireDrive(ctx, msg.ChatID, msg.SenderID) {
		return true
	}

	targetURL := urls[0]
	domain, codeID, err := shortshare.ParseURL(targetURL)
	if err != nil {
		return false
	}

	// 防重与防抖：3秒内相同 chat + domain + codeID 忽略
	dedupKey := fmt.Sprintf("%d:%s:%s", msg.ChatID, domain, codeID)
	a.shortshareReqMu.Lock()
	now := time.Now()
	if last, ok := a.shortshareReqs[dedupKey]; ok && time.Since(last) < 3*time.Second {
		a.shortshareReqMu.Unlock()
		return true
	}
	a.shortshareReqs[dedupKey] = now
	for k, t := range a.shortshareReqs {
		if now.Sub(t) > 10*time.Second {
			delete(a.shortshareReqs, k)
		}
	}
	a.shortshareReqMu.Unlock()

	// 权限检查
	if !a.can(ctx, userID, auth.ActionExternalLink) {
		_ = a.tg.SendMessage(ctx, msg.ChatID, "⛔ 您没有权限转存外部链接资源。")
		return true
	}

	// 初始解析，使用默认日期密码
	res, err := a.shortshareClient.Extract(ctx, targetURL, "")
	if err != nil {
		if errors.Is(err, shortshare.ErrPasswordRequired) {
			nonce := newShortshareNonce()
			promptText := fmt.Sprintf("🔐 <b>该短链资源设有访问密码</b>\n\n"+
				"🌐 来源: <code>%s</code>\n"+
				"系统已自动尝试当天或上传日期默认密码未能解密。\n\n"+
				"请直接回复该资源的访问密码（群聊中请<b>引用此消息回复</b>）：",
				escapeHTMLText(shortshare.NormalizeURL(targetURL)),
			)
			buttons := [][]tgclient.Button{
				{
					{Text: "❌ 取消", Data: "shortshare_cancel_" + nonce},
				},
			}
			promptMsgID, _ := a.tg.SendWithButtonsAndID(ctx, msg.ChatID, promptText, buttons)

			if a.bindSessions != nil {
				sessData := map[string]string{
					"nonce":         nonce,
					"chat_id":       fmt.Sprintf("%d", msg.ChatID),
					"url":           targetURL,
					"domain":        domain,
					"code_id":       codeID,
					"prompt_msg_id": fmt.Sprintf("%d", promptMsgID),
					"retry_count":   "0",
					"created_at":    fmt.Sprintf("%d", time.Now().Unix()),
				}
				_ = a.bindSessions.Start(ctx, userID, "SHORTSHARE_WAIT_PASS", sessData)
			}
			return true
		}

		if errors.Is(err, shortshare.ErrNotFound) {
			_ = a.tg.SendMessage(ctx, msg.ChatID, "❌ 该短链资源不存在或已失效。")
			return true
		}

		if errors.Is(err, shortshare.ErrAntiBotBlocked) {
			_ = a.tg.SendMessage(ctx, msg.ChatID, "⚠️ 遭遇目标站点反爬拦截，暂无法自动抓取。")
			return true
		}

		a.log.Warn("解析短链失败", "url", targetURL, "err", err)
		_ = a.tg.SendMessage(ctx, msg.ChatID, fmt.Sprintf("❌ 短链解析失败: %s", escapeHTMLText(err.Error())))
		return true
	}

	// 解析成功，展示确认卡片
	a.renderShortshareSuccess(ctx, userID, msg.ChatID, res)
	return true
}

func (a *App) renderShortshareSuccess(ctx context.Context, userID string, chatID int64, res *shortshare.ExtractResult) {
	if len(res.Items) == 0 {
		_ = a.tg.SendMessage(ctx, chatID, "⚠️ 未在页面中发现可转存的媒体资源。")
		return
	}

	nonce := newShortshareNonce()
	itemsJSON, _ := json.Marshal(res.Items)

	if a.bindSessions != nil {
		sessData := map[string]string{
			"nonce":      nonce,
			"chat_id":    fmt.Sprintf("%d", chatID),
			"url":        res.OriginalURL,
			"domain":     res.Domain,
			"code_id":    res.CodeID,
			"items":      string(itemsJSON),
			"created_at": fmt.Sprintf("%d", time.Now().Unix()),
		}
		_ = a.bindSessions.Start(ctx, userID, "SHORTSHARE_CONFIRM", sessData)
	}

	var pwdTip string
	if res.PasswordUsed != "" {
		pwdTip = fmt.Sprintf("\n🔐 访问密码: <code>%s</code> (自动解密)", escapeHTMLText(res.PasswordUsed))
	}

	if len(res.Items) == 1 {
		item := res.Items[0]
		text := fmt.Sprintf("🔗 <b>发现短链资源</b>\n\n"+
			"📄 名称: <code>%s</code>\n"+
			"🌐 来源: <code>%s</code>%s",
			escapeHTMLText(item.FileName),
			escapeHTMLText(shortshare.NormalizeURL(res.OriginalURL)),
			pwdTip,
		)
		buttons := [][]tgclient.Button{
			{
				{Text: "❌ 取消", Data: "shortshare_cancel_" + nonce},
				{Text: "✅ 确认转存", Data: "shortshare_confirm_" + nonce},
			},
		}
		_ = a.tg.SendWithButtons(ctx, chatID, text, buttons)
		return
	}

	text := fmt.Sprintf("📚 <b>发现短链资源包 / 相册</b>\n\n"+
		"📦 包含文件: <code>%d 个媒体文件</code>\n"+
		"🌐 来源: <code>%s</code>%s",
		len(res.Items),
		escapeHTMLText(shortshare.NormalizeURL(res.OriginalURL)),
		pwdTip,
	)
	buttons := [][]tgclient.Button{
		{
			{Text: "❌ 取消", Data: "shortshare_cancel_" + nonce},
			{Text: fmt.Sprintf("📥 全部转存 (%d个文件)", len(res.Items)), Data: "shortshare_all_" + nonce},
		},
	}
	_ = a.tg.SendWithButtons(ctx, chatID, text, buttons)
}

// handleShortshareInput 拦截用户在 SHORTSHARE_WAIT_PASS 步骤时输入的密码。
func (a *App) handleShortshareInput(ctx context.Context, msg messageInfo, text string) bool {
	if a.shortshareClient == nil || a.bindSessions == nil {
		return false
	}
	userID := fmt.Sprintf("%d", msg.SenderID)
	sess, err := a.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil || sess.CurrentStep != "SHORTSHARE_WAIT_PASS" {
		return false
	}

	// 如果用户发送了另一个短链链接，重置旧等待会话并作为新短链请求放行
	if len(shortshare.ExtractShortshareURLs(text)) > 0 {
		_ = a.bindSessions.Clear(ctx, userID)
		return false
	}

	// 群聊安全防干扰：如果是群聊，要求必须回复提示卡片
	if msg.ChatID < 0 {
		promptMsgID := sess.Data["prompt_msg_id"]
		if promptMsgID != "" && fmt.Sprintf("%d", msg.ReplyToMsgID) != promptMsgID {
			return false
		}
	}

	// 检查会话超时（15分钟）
	if createdAtUnix, err := strconv.ParseInt(sess.Data["created_at"], 10, 64); err == nil {
		if time.Now().Unix()-createdAtUnix > 15*60 {
			_ = a.bindSessions.Clear(ctx, userID)
			_ = a.tg.SendMessage(ctx, msg.ChatID, "⏱️ 密码输入会话已超时，请重新发送链接。")
			return true
		}
	}

	trimmedText := strings.TrimSpace(text)
	if trimmedText == "/cancel" || strings.EqualFold(trimmedText, "cancel") {
		_ = a.bindSessions.Clear(ctx, userID)
		_ = a.tg.SendMessage(ctx, msg.ChatID, "✅ 已取消短链资源转存。")
		return true
	}

	// 敏感信息安全处理：尝试删除用户明文输入的密码（群聊若无管理员权限则静默忽略错误）
	_ = a.tg.DeleteMessages(ctx, msg.ChatID, []int64{int64(msg.ID)})

	retryCount, _ := strconv.Atoi(sess.Data["retry_count"])
	retryCount++
	if retryCount > 3 {
		_ = a.bindSessions.Clear(ctx, userID)
		_ = a.tg.SendMessage(ctx, msg.ChatID, "❌ 密码错误次数过多，已取消该任务。")
		return true
	}

	targetURL := sess.Data["url"]
	res, err := a.shortshareClient.Extract(ctx, targetURL, trimmedText)
	if err != nil {
		sess.Data["retry_count"] = strconv.Itoa(retryCount)
		_ = a.bindSessions.Start(ctx, userID, "SHORTSHARE_WAIT_PASS", sess.Data)

		remaining := 3 - retryCount
		_ = a.tg.SendMessage(ctx, msg.ChatID, fmt.Sprintf("❌ 密码错误，剩余尝试次数 %d 次，请重新输入（或回复 /cancel 取消）：", remaining))
		return true
	}

	// 密码正确，清除等待密码会话，转入确认转存面板
	_ = a.bindSessions.Clear(ctx, userID)
	a.renderShortshareSuccess(ctx, userID, msg.ChatID, res)
	return true
}

// handleShortshareCallback 处理短链交互确认面板的按钮回调。
func (a *App) handleShortshareCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	if a.bindSessions == nil {
		answer("会话存储不可用", true)
		return nil
	}

	sess, err := a.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil || (!strings.HasPrefix(sess.CurrentStep, "SHORTSHARE_")) {
		answer("任务已不存在或已处理", true)
		return nil
	}

	var expectedNonce string
	isCancel := strings.HasPrefix(data, "shortshare_cancel_")
	isConfirm := strings.HasPrefix(data, "shortshare_confirm_")
	isAll := strings.HasPrefix(data, "shortshare_all_")

	switch {
	case isCancel:
		expectedNonce = strings.TrimPrefix(data, "shortshare_cancel_")
	case isConfirm:
		expectedNonce = strings.TrimPrefix(data, "shortshare_confirm_")
	case isAll:
		expectedNonce = strings.TrimPrefix(data, "shortshare_all_")
	default:
		answer("未知的操作", true)
		return nil
	}

	if sess.Data["nonce"] != expectedNonce || sess.Data["chat_id"] != fmt.Sprintf("%d", cb.ChatID) {
		answer("任务已不存在或已处理", true)
		return nil
	}

	if isCancel {
		_ = a.bindSessions.Clear(ctx, userID)
		answer("已取消转存", false)
		_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, "🚫 转存已取消。")
		return nil
	}

	// 确认转存或全部转存
	var items []shortshare.MediaItem
	if err := json.Unmarshal([]byte(sess.Data["items"]), &items); err != nil || len(items) == 0 {
		answer("无法获取转存文件列表", true)
		return nil
	}

	_ = a.bindSessions.Clear(ctx, userID)

	withNotice := len(items) <= 3
	for _, item := range items {
		a.enqueueShortshareItem(ctx, userID, cb.ChatID, cb.MsgID, item, sess.Data["url"], withNotice)
	}

	answer("已加入转存队列", false)
	_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, fmt.Sprintf(
		"✅ <b>已加入转存队列</b>\n\n"+
			"📦 文件数量: <code>%d 个文件</code>\n"+
			"🌐 来源短链: <code>%s</code>\n\n"+
			"正在排队下载并同步至您的网盘...",
		len(items),
		escapeHTMLText(shortshare.NormalizeURL(sess.Data["url"])),
	))
	return nil
}

func (a *App) enqueueShortshareItem(ctx context.Context, userID string, chatID int64, srcMsgID int, item shortshare.MediaItem, originalURL string, withNotice bool) {
	taskID := newTaskID()
	var noticeID int
	if withNotice {
		noticeID = a.postNotice(ctx, chatID, taskID)
	}

	headers := make(map[string]string)
	for k, v := range item.Headers {
		headers[k] = v
	}
	if headers["Referer"] == "" {
		headers["Referer"] = originalURL
	}

	refData, _ := json.Marshal(externalSourceRef{
		URL:      item.URL,
		WebURL:   originalURL,
		Platform: "shortshare",
		Headers:  headers,
	})

	t := store.Task{
		ID:          taskID,
		UserID:      userID,
		ChatID:      nullableString(fmt.Sprintf("%d", chatID)),
		SourceType:  "external_url",
		FileName:    nullableString(item.FileName),
		FileSize:    item.FileSize,
		SourceRef:   nullableString(string(refData)),
		MsgID:       nullableInt(int64(noticeID)),
		SourceMsgID: nullableInt(int64(srcMsgID)),
	}

	if err := a.repo.Create(ctx, t); err != nil {
		a.log.Error("创建短链转存任务失败", "taskId", taskID, "err", err)
		return
	}

	a.enqueue(ctx, taskID)
	a.log.Info("已创建短链转存任务", "taskId", taskID, "file", item.FileName)
}
