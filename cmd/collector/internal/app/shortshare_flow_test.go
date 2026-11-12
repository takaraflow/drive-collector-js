package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	"github.com/youngsx/drive-collector/cmd/collector/internal/shortshare"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

type mockShortshareExtractor struct {
	extractFunc func(ctx context.Context, rawURL string, password string) (*shortshare.ExtractResult, error)
}

func (m *mockShortshareExtractor) Extract(ctx context.Context, rawURL string, password string) (*shortshare.ExtractResult, error) {
	if m.extractFunc != nil {
		return m.extractFunc(ctx, rawURL, password)
	}
	return nil, shortshare.ErrNotFound
}

func setupShortshareTestApp(t *testing.T) (*App, *fakeExternalTG, *fakeRepo, func()) {
	t.Helper()

	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis error: %v", err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	repo := &fakeRepo{}
	drives := boundDrive()
	tg := &fakeExternalTG{}

	authorizer := &fakeAuthorizer{
		perms: map[string]map[auth.Action]bool{
			"100": {auth.ActionExternalLink: true},
		},
	}

	app := newTestLinkApp(repo, drives, nil, &linkMockNotices{})
	app.tg = tg
	app.notifier = tg
	app.notices = tg
	app.auth = authorizer
	app.bindSessions = bindingsession.NewStore(rdb)
	app.shortshareClient = &mockShortshareExtractor{}
	app.shortshareReqs = make(map[string]time.Time)

	cleanup := func() {
		_ = rdb.Close()
		mr.Close()
	}

	return app, tg, repo, cleanup
}

func TestShortshareMessage_NoPasswordSuccess(t *testing.T) {
	app, tg, _, cleanup := setupShortshareTestApp(t)
	defer cleanup()

	ctx := context.Background()
	app.shortshareClient = &mockShortshareExtractor{
		extractFunc: func(ctx context.Context, rawURL string, password string) (*shortshare.ExtractResult, error) {
			return &shortshare.ExtractResult{
				OriginalURL:  rawURL,
				Domain:       "lurl.cc",
				CodeID:       "vid123",
				Title:        "测试视频",
				PasswordUsed: "1113",
				Items: []shortshare.MediaItem{
					{
						URL:      "https://cdn.lurl.cc/vid123.mp4",
						FileName: "vid123.mp4",
					},
				},
			}, nil
		},
	}

	msg := messageInfo{
		ID:       10,
		ChatID:   12345,
		SenderID: 100,
		Text:     "快看这个短链 https://lurl.cc/vid123",
	}

	handled := app.handleShortshareMessage(ctx, msg)
	if !handled {
		t.Fatalf("expected message to be handled")
	}

	// 验证发送了确认转存卡片
	if len(tg.sentTexts) == 0 {
		t.Fatalf("expected confirmation message sent")
	}
	lastSent := tg.sentTexts[len(tg.sentTexts)-1]
	if !strings.Contains(lastSent, "发现短链资源") || !strings.Contains(lastSent, "vid123.mp4") {
		t.Errorf("unexpected card text: %s", lastSent)
	}

	// 验证生成了会话
	sess, err := app.bindSessions.Get(ctx, "100")
	if err != nil || sess == nil || sess.CurrentStep != "SHORTSHARE_CONFIRM" {
		t.Fatalf("expected SHORTSHARE_CONFIRM session, got %v", sess)
	}
}

func TestShortshareMessage_PasswordFlow(t *testing.T) {
	app, tg, _, cleanup := setupShortshareTestApp(t)
	defer cleanup()

	ctx := context.Background()
	app.shortshareClient = &mockShortshareExtractor{
		extractFunc: func(ctx context.Context, rawURL string, password string) (*shortshare.ExtractResult, error) {
			if password == "" {
				return nil, shortshare.ErrPasswordRequired
			}
			if password == "right99" {
				return &shortshare.ExtractResult{
					OriginalURL:  rawURL,
					Domain:       "myppt.cc",
					CodeID:       "secret1",
					PasswordUsed: "right99",
					Items: []shortshare.MediaItem{
						{URL: "https://img.myppt.cc/p1.jpg", FileName: "p1.jpg"},
						{URL: "https://img.myppt.cc/p2.jpg", FileName: "p2.jpg"},
					},
				}, nil
			}
			return nil, shortshare.ErrPasswordWrong
		},
	}

	// 1. 发送加密链接，触发密码输入提示
	msg := messageInfo{
		ID:       11,
		ChatID:   12345,
		SenderID: 100,
		Text:     "https://myppt.cc/secret1",
	}
	if !app.handleShortshareMessage(ctx, msg) {
		t.Fatalf("expected handled")
	}

	sess, err := app.bindSessions.Get(ctx, "100")
	if err != nil || sess == nil || sess.CurrentStep != "SHORTSHARE_WAIT_PASS" {
		t.Fatalf("expected SHORTSHARE_WAIT_PASS session, got %v", sess)
	}

	// 2. 用户输入错误密码
	wrongMsg := messageInfo{
		ID:       12,
		ChatID:   12345,
		SenderID: 100,
		Text:     "wrong_pass",
	}
	if !app.handleShortshareInput(ctx, wrongMsg, wrongMsg.Text) {
		t.Fatalf("expected wrong password input handled")
	}

	sess, _ = app.bindSessions.Get(ctx, "100")
	if sess == nil || sess.Data["retry_count"] != "1" {
		t.Fatalf("expected retry_count=1, got %v", sess)
	}

	// 3. 用户输入正确密码
	rightMsg := messageInfo{
		ID:       13,
		ChatID:   12345,
		SenderID: 100,
		Text:     "right99",
	}
	if !app.handleShortshareInput(ctx, rightMsg, rightMsg.Text) {
		t.Fatalf("expected right password input handled")
	}

	// 验证进入了相册确认状态
	sess, _ = app.bindSessions.Get(ctx, "100")
	if sess == nil || sess.CurrentStep != "SHORTSHARE_CONFIRM" {
		t.Fatalf("expected SHORTSHARE_CONFIRM session, got %v", sess)
	}

	lastSent := tg.sentTexts[len(tg.sentTexts)-1]
	if !strings.Contains(lastSent, "2 个媒体文件") {
		t.Errorf("expected album text, got %s", lastSent)
	}
}

func TestShortshareMessage_GroupAntiInterference(t *testing.T) {
	app, _, _, cleanup := setupShortshareTestApp(t)
	defer cleanup()

	ctx := context.Background()
	app.shortshareClient = &mockShortshareExtractor{
		extractFunc: func(ctx context.Context, rawURL string, password string) (*shortshare.ExtractResult, error) {
			if password == "" {
				return nil, shortshare.ErrPasswordRequired
			}
			if password == "pass123" {
				return &shortshare.ExtractResult{
					OriginalURL: rawURL,
					Domain:      "lurl.cc",
					CodeID:      "grouptest",
					Items: []shortshare.MediaItem{
						{URL: "https://cdn.lurl.cc/test.mp4", FileName: "test.mp4"},
					},
				}, nil
			}
			return nil, shortshare.ErrPasswordWrong
		},
	}

	// 1. 发送加密短链到群聊中
	groupMsg := messageInfo{
		ID:       15,
		ChatID:   -1001234567,
		SenderID: 100,
		Text:     "https://lurl.cc/grouptest",
	}
	if !app.handleShortshareMessage(ctx, groupMsg) {
		t.Fatalf("expected handled")
	}

	// 验证 session 中的 prompt_msg_id 为有效的整数，不是 "%!d(<nil>)"
	sess, err := app.bindSessions.Get(ctx, "100")
	if err != nil || sess == nil || sess.CurrentStep != "SHORTSHARE_WAIT_PASS" {
		t.Fatalf("expected SHORTSHARE_WAIT_PASS session, got %v", sess)
	}
	promptMsgIDStr := sess.Data["prompt_msg_id"]
	if promptMsgIDStr == "" || strings.Contains(promptMsgIDStr, "nil") {
		t.Fatalf("invalid prompt_msg_id in session: %q", promptMsgIDStr)
	}

	// 2. 群聊普通发言，未引用 promptMsgID
	groupNormalMsg := messageInfo{
		ID:           20,
		ChatID:       -1001234567,
		SenderID:     100,
		Text:         "大家今天中午吃什么？",
		ReplyToMsgID: 19,
	}
	if app.handleShortshareInput(ctx, groupNormalMsg, groupNormalMsg.Text) {
		t.Errorf("normal group message should NOT be intercepted")
	}

	// 3. 群聊发送新的短链链接，重置会话并放行
	newLinkMsg := messageInfo{
		ID:           21,
		ChatID:       -1001234567,
		SenderID:     100,
		Text:         "https://myppt.cc/newcode",
		ReplyToMsgID: 19,
	}
	if app.handleShortshareInput(ctx, newLinkMsg, newLinkMsg.Text) {
		t.Errorf("new shortshare url message should not be intercepted as password")
	}
	// 会话应已被清理
	sessAfterNewLink, _ := app.bindSessions.Get(ctx, "100")
	if sessAfterNewLink != nil {
		t.Errorf("session should be reset after new shortshare link")
	}

	// 清空防抖记录后重新发送 grouptest 触发等待密码状态
	app.shortshareReqMu.Lock()
	app.shortshareReqs = make(map[string]time.Time)
	app.shortshareReqMu.Unlock()

	_ = app.handleShortshareMessage(ctx, groupMsg)
	sess, _ = app.bindSessions.Get(ctx, "100")
	if sess == nil {
		t.Fatalf("expected session recreated")
	}
	promptID := 0
	fmt.Sscanf(sess.Data["prompt_msg_id"], "%d", &promptID)

	// 4. 群聊引用回复 promptMsgID
	groupReplyMsg := messageInfo{
		ID:           22,
		ChatID:       -1001234567,
		SenderID:     100,
		Text:         "pass123",
		ReplyToMsgID: promptID,
	}
	if !app.handleShortshareInput(ctx, groupReplyMsg, groupReplyMsg.Text) {
		t.Errorf("reply to prompt card should be intercepted")
	}

	// 验证成功进入确认阶段
	sess, _ = app.bindSessions.Get(ctx, "100")
	if sess == nil || sess.CurrentStep != "SHORTSHARE_CONFIRM" {
		t.Fatalf("expected SHORTSHARE_CONFIRM session, got %v", sess)
	}
}

func TestShortshareCallback_ConfirmAndCancel(t *testing.T) {
	app, tg, repo, cleanup := setupShortshareTestApp(t)
	defer cleanup()

	ctx := context.Background()
	nonce := "noncetest123"

	// 1. 测试 Cancel
	_ = app.bindSessions.Start(ctx, "100", "SHORTSHARE_CONFIRM", map[string]string{
		"nonce":   nonce,
		"chat_id": "12345",
		"url":     "https://lurl.cc/testcancel",
	})
	cbCancel := tgclient.CallbackContext{
		ChatID:     12345,
		UserID:     100,
		MsgID:      99,
		CallbackID: 1,
	}
	if err := app.handleShortshareCallback(ctx, cbCancel, "shortshare_cancel_"+nonce); err != nil {
		t.Fatalf("handle callback error: %v", err)
	}

	sess, _ := app.bindSessions.Get(ctx, "100")
	if sess != nil {
		t.Errorf("session should be cleared after cancel")
	}
	if len(tg.editedTexts) == 0 || !strings.Contains(tg.editedTexts[len(tg.editedTexts)-1], "已取消") {
		t.Errorf("expected cancel edit message")
	}

	// 2. 测试 Confirm 创建任务
	nonce2 := "nonceconfirm456"
	itemsJSON := `[{"url":"https://cdn.lurl.cc/v.mp4","file_name":"v.mp4"}]`
	_ = app.bindSessions.Start(ctx, "100", "SHORTSHARE_CONFIRM", map[string]string{
		"nonce":   nonce2,
		"chat_id": "12345",
		"url":     "https://lurl.cc/v",
		"items":   itemsJSON,
	})
	cbConfirm := tgclient.CallbackContext{
		ChatID:     12345,
		UserID:     100,
		MsgID:      100,
		CallbackID: 2,
	}
	if err := app.handleShortshareCallback(ctx, cbConfirm, "shortshare_confirm_"+nonce2); err != nil {
		t.Fatalf("handle confirm callback error: %v", err)
	}

	if len(repo.created) != 1 {
		t.Fatalf("expected 1 task created, got %d", len(repo.created))
	}
	task := repo.created[0]
	if task.FileName.String != "v.mp4" || task.SourceType != "external_url" {
		t.Errorf("unexpected task: %+v", task)
	}
	if !strings.Contains(task.SourceRef.String, `"platform":"shortshare"`) {
		t.Errorf("expected platform shortshare in source ref, got %s", task.SourceRef.String)
	}
}

func TestShortshare_CancelCommand(t *testing.T) {
	app, tg, _, cleanup := setupShortshareTestApp(t)
	defer cleanup()

	ctx := context.Background()
	_ = app.bindSessions.Start(ctx, "100", "SHORTSHARE_WAIT_PASS", map[string]string{
		"url": "https://lurl.cc/waitcancel",
	})

	msg := messageInfo{
		ID:       55,
		ChatID:   12345,
		SenderID: 100,
		Text:     "/cancel",
	}

	if err := app.handleCancelCommand(ctx, msg); err != nil {
		t.Fatalf("handleCancelCommand error: %v", err)
	}

	sess, _ := app.bindSessions.Get(ctx, "100")
	if sess != nil {
		t.Errorf("session should be cleared")
	}

	lastSent := tg.sentTexts[len(tg.sentTexts)-1]
	if !strings.Contains(lastSent, "已取消短链资源转存") {
		t.Errorf("unexpected cancel message: %s", lastSent)
	}
}
