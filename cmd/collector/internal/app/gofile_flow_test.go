package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	"github.com/youngsx/drive-collector/cmd/collector/internal/gofile"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

func TestRenderGofileFolderView_Pagination(t *testing.T) {
	// 构造 12 个文件测试 3 页分页
	var files []gofile.FileItem
	for i := 1; i <= 12; i++ {
		files = append(files, gofile.FileItem{
			ID:   fmt.Sprintf("f%d", i),
			Name: fmt.Sprintf("video_%02d.mp4", i),
			Size: int64(i * 1024 * 1024),
		})
	}

	nonce := "testnonce123"

	// 1. 第 0 页 (首页)
	text0, btns0 := renderGofileFolderView("MyFolder", files, 0, nonce, nil)
	if !strings.Contains(text0, "第 <b>1</b> / <b>3</b> 页") {
		t.Errorf("expected page 1/3, got %s", text0)
	}
	if !strings.Contains(text0, "video_01.mp4") || !strings.Contains(text0, "video_05.mp4") {
		t.Errorf("expected files 1-5 on page 0, got %s", text0)
	}
	if strings.Contains(text0, "video_06.mp4") {
		t.Errorf("file 6 should not appear on page 0")
	}

	// 验证按钮结构
	hasPrev0 := false
	hasNext0 := false
	hasAll0 := false
	hasCancel0 := false
	for _, row := range btns0 {
		for _, b := range row {
			if strings.Contains(b.Text, "上一页") {
				hasPrev0 = true
			}
			if strings.Contains(b.Text, "下一页") {
				hasNext0 = true
			}
			if strings.Contains(b.Text, "全部转存") {
				hasAll0 = true
			}
			if strings.Contains(b.Text, "取消") {
				hasCancel0 = true
			}
		}
	}
	if hasPrev0 {
		t.Errorf("page 0 should not have prev button")
	}
	if !hasNext0 {
		t.Errorf("page 0 should have next button")
	}
	if !hasAll0 || !hasCancel0 {
		t.Errorf("page 0 must have all and cancel buttons")
	}

	// 2. 第 1 页 (中间页)
	_, btns1 := renderGofileFolderView("MyFolder", files, 1, nonce, nil)
	hasPrev1 := false
	hasNext1 := false
	for _, row := range btns1 {
		for _, b := range row {
			if strings.Contains(b.Text, "上一页") {
				hasPrev1 = true
			}
			if strings.Contains(b.Text, "下一页") {
				hasNext1 = true
			}
		}
	}
	if !hasPrev1 || !hasNext1 {
		t.Errorf("page 1 should have both prev and next buttons")
	}

	// 3. 第 2 页 (末页)
	_, btns2 := renderGofileFolderView("MyFolder", files, 2, nonce, nil)
	hasPrev2 := false
	hasNext2 := false
	for _, row := range btns2 {
		for _, b := range row {
			if strings.Contains(b.Text, "上一页") {
				hasPrev2 = true
			}
			if strings.Contains(b.Text, "下一页") {
				hasNext2 = true
			}
		}
	}
	if !hasPrev2 {
		t.Errorf("page 2 should have prev button")
	}
	if hasNext2 {
		t.Errorf("page 2 should not have next button")
	}

	// 4. 测试带有已选文件时的渲染（多选视觉反馈）
	queuedMap := map[string]bool{"f1": true, "f3": true}
	textQueued, btnsQueued := renderGofileFolderView("MyFolder", files, 0, nonce, queuedMap)
	if !strings.Contains(textQueued, "已提交转存:</b> <code>2</code> 个文件") {
		t.Errorf("expected queued files summary, got %s", textQueued)
	}
	if !strings.Contains(textQueued, "✅ <b>1.</b>") || !strings.Contains(textQueued, "[已提交]") {
		t.Errorf("expected file 1 marked as queued, got %s", textQueued)
	}

	hasRemainingBtn := false
	hasDoneBtn := false
	for _, row := range btnsQueued {
		for _, b := range row {
			if strings.Contains(b.Text, "转存剩余全部") {
				hasRemainingBtn = true
			}
			if strings.Contains(b.Text, "完成选择 (2)") {
				hasDoneBtn = true
			}
		}
	}
	if !hasRemainingBtn {
		t.Errorf("expected '转存剩余全部' button when some files are queued")
	}
	if !hasDoneBtn {
		t.Errorf("expected '完成选择' button when some files are queued")
	}
}

func setupGofileTestApp(t *testing.T) (*App, *fakeExternalTG, *fakeRepo, func()) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
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
	app.gofileClient = gofile.NewClient()
	app.gofileReqs = make(map[string]time.Time)

	cleanup := func() {
		_ = rdb.Close()
		mr.Close()
	}

	return app, tg, repo, cleanup
}

func TestGofileCallback_Actions(t *testing.T) {
	app, ft, repo, cleanup := setupGofileTestApp(t)
	defer cleanup()

	ctx := context.Background()
	userID := "100"
	chatID := int64(12345)
	nonce := "mocknonce888"

	files := []gofile.FileItem{
		{ID: "f1", Name: "test1.mp4", Size: 1024 * 1024, Link: "https://gofile.io/dl/1"},
		{ID: "f2", Name: "test2.mp4", Size: 2 * 1024 * 1024, Link: "https://gofile.io/dl/2"},
	}
	filesData, _ := json.Marshal(files)

	// 1. 测试 Cancel (未选任何文件时)
	_ = app.bindSessions.Start(ctx, userID, "GOFILE_SELECT", map[string]string{
		"nonce":         nonce,
		"chat_id":       fmt.Sprintf("%d", chatID),
		"folder_name":   "TestFolder",
		"account_token": "token-xyz",
		"page":          "0",
		"files":         string(filesData),
		"queued":        "",
	})

	cbCancel := tgclient.CallbackContext{
		ChatID:     chatID,
		UserID:     100,
		MsgID:      999,
		CallbackID: 1,
	}
	err := app.handleGofileCallback(ctx, cbCancel, "gofile_cancel_"+nonce)
	if err != nil {
		t.Fatalf("handle cancel error: %v", err)
	}

	// 验证会话已被清除
	sess, _ := app.bindSessions.Get(ctx, userID)
	if sess != nil {
		t.Errorf("session should be cleared after cancel")
	}

	// 2. 测试连续点选（Multi Pick）：点选第一个文件，会话不应该被清除！面板不消失
	nonce2 := "nonce222"
	_ = app.bindSessions.Start(ctx, userID, "GOFILE_SELECT", map[string]string{
		"nonce":         nonce2,
		"chat_id":       fmt.Sprintf("%d", chatID),
		"folder_name":   "TestFolder",
		"account_token": "token-xyz",
		"page":          "0",
		"files":         string(filesData),
		"queued":        "",
	})

	err = app.handleGofileCallback(ctx, cbCancel, "gofile_pick_0_"+nonce2)
	if err != nil {
		t.Fatalf("handle pick error: %v", err)
	}

	// 验证第一个任务已创建
	if len(repo.created) != 1 {
		t.Fatalf("expected 1 task created, got %d", len(repo.created))
	}
	task := repo.created[0]
	if task.FileName.String != "test1.mp4" {
		t.Errorf("task filename = %q, want test1.mp4", task.FileName.String)
	}

	// 验证关键设计：会话仍然有效，且已记录 f1 为已选
	sess, err = app.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil {
		t.Fatalf("session must remain active for continuous selection")
	}
	if sess.Data["queued"] != "f1" {
		t.Errorf("expected queued = f1, got %q", sess.Data["queued"])
	}

	// 3. 测试防抖与重复点击（再次点选已被加入的文件）
	err = app.handleGofileCallback(ctx, cbCancel, "gofile_pick_0_"+nonce2)
	if err != nil {
		t.Fatalf("duplicate click should not error: %v", err)
	}
	// 不应创建新任务
	if len(repo.created) != 1 {
		t.Fatalf("duplicate click should not create second task, got %d", len(repo.created))
	}

	// 4. 测试继续点选第二个文件（连续多选！）
	err = app.handleGofileCallback(ctx, cbCancel, "gofile_pick_1_"+nonce2)
	if err != nil {
		t.Fatalf("second pick error: %v", err)
	}
	if len(repo.created) != 2 {
		t.Fatalf("expected 2 tasks created after picking second file, got %d", len(repo.created))
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if !strings.Contains(sess.Data["queued"], "f1") || !strings.Contains(sess.Data["queued"], "f2") {
		t.Errorf("expected both f1 and f2 in queued, got %q", sess.Data["queued"])
	}

	// 5. 点击「完成选择」
	err = app.handleGofileCallback(ctx, cbCancel, "gofile_done_"+nonce2)
	if err != nil {
		t.Fatalf("done click error: %v", err)
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess != nil {
		t.Errorf("session should be cleared after done")
	}

	// 6. 测试点选部分后点击「转存剩余全部」
	nonce3 := "nonce333"
	_ = app.bindSessions.Start(ctx, userID, "GOFILE_SELECT", map[string]string{
		"nonce":         nonce3,
		"chat_id":       fmt.Sprintf("%d", chatID),
		"folder_name":   "TestFolder",
		"account_token": "token-xyz",
		"page":          "0",
		"files":         string(filesData),
		"queued":        "f1", // 模拟已经选了 f1
	})

	err = app.handleGofileCallback(ctx, cbCancel, "gofile_all_"+nonce3)
	if err != nil {
		t.Fatalf("handle pick all with partial queued error: %v", err)
	}

	// 之前有 2 个任务，这次只应该把剩余的 f2 入队（+1 个任务），总共 3 个任务
	if len(repo.created) != 3 {
		t.Fatalf("expected 3 tasks total (f2 enqueued), got %d", len(repo.created))
	}

	// 会话已清理
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess != nil {
		t.Errorf("session should be cleared after pick all")
	}

	_ = ft
}

func TestHandleGofileMessage_Debounce(t *testing.T) {
	app, _, _, cleanup := setupGofileTestApp(t)
	defer cleanup()

	ctx := context.Background()
	msg := messageInfo{
		ChatID:   12345,
		SenderID: 100,
		Text:     "https://gofile.io/d/testDebounce123",
	}

	// 首次记录防抖 key
	dedupKey := "12345:testDebounce123"
	app.gofileReqMu.Lock()
	app.gofileReqs[dedupKey] = time.Now()
	app.gofileReqMu.Unlock()

	// 紧接着再次调用，应该直接返回 true（防抖生效，被过滤）
	handled := app.handleGofileMessage(ctx, msg)
	if !handled {
		t.Errorf("expected debounced message to be handled (suppressed)")
	}
}
