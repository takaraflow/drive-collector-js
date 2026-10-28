package app

import (
	"context"
	"net"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

func TestExtractExternalHTTPURLs(t *testing.T) {
	text := "Check these: https://example.com/file1.zip, and (http://example.com/file2.tar.gz).\n" +
		"Also skip https://t.me/somechannel/123 and https://twitter.com/jack/status/20\n" +
		"And skip https://example.com/download.torrent and duplicate https://example.com/file1.zip"

	urls := extractExternalHTTPURLs(text)
	if len(urls) != 2 {
		t.Fatalf("expected 2 URLs, got %d: %v", len(urls), urls)
	}
	if urls[0] != "https://example.com/file1.zip" {
		t.Errorf("url[0] = %q, want https://example.com/file1.zip", urls[0])
	}
	if urls[1] != "http://example.com/file2.tar.gz" {
		t.Errorf("url[1] = %q, want http://example.com/file2.tar.gz", urls[1])
	}
}

func TestFindUnsupportedExternalLinks(t *testing.T) {
	text := "Unsupported: magnet:?xt=urn:btih:12345, ed2k://|file|test.dat|123|ABC|/ and ftp://ftp.example.com/pub/file\n" +
		"Also http://example.com/arch.torrent file"

	unsupported := findUnsupportedExternalLinks(text)
	if len(unsupported) != 4 {
		t.Fatalf("expected 4 unsupported links, got %d: %v", len(unsupported), unsupported)
	}
}

func TestIsBlockedIP(t *testing.T) {
	blockedCases := []string{
		"127.0.0.1",
		"10.0.0.5",
		"192.168.1.100",
		"172.16.5.1",
		"169.254.169.254",
		"::1",
		"fe80::1",
	}
	for _, ipStr := range blockedCases {
		ip := net.ParseIP(ipStr)
		if !isBlockedIP(ip) {
			t.Errorf("IP %s should be blocked", ipStr)
		}
	}

	allowedCases := []string{
		"8.8.8.8",
		"1.1.1.1",
		"142.250.190.46",
	}
	for _, ipStr := range allowedCases {
		ip := net.ParseIP(ipStr)
		if isBlockedIP(ip) {
			t.Errorf("IP %s should be allowed", ipStr)
		}
	}
}

func TestParseContentDispositionFileName(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{`attachment; filename="sample.zip"`, "sample.zip"},
		{`inline; filename=document.pdf`, "document.pdf"},
		{`attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.txt`, "测试.txt"},
		{`attachment; filename="fallback.iso"; filename*=utf-8''custom.iso`, "custom.iso"},
		{"", ""},
	}

	for _, tc := range cases {
		got := parseContentDispositionFileName(tc.header)
		if got != tc.want {
			t.Errorf("parseContentDispositionFileName(%q) = %q, want %q", tc.header, got, tc.want)
		}
	}
}

func TestSanitizeExternalFileName(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"../../etc/passwd", "passwd"},
		{"my:illegal*file?.pdf", "my_illegal_file_.pdf"},
		{"", "download.bin"},
		{"   ", "download.bin"},
		{"...hidden...", "hidden"},
	}

	for _, tc := range cases {
		got := sanitizeExternalFileName(tc.input)
		if got != tc.want {
			t.Errorf("sanitizeExternalFileName(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestFormatBytes(t *testing.T) {
	if got := formatBytes(0); got != "未知大小" {
		t.Errorf("formatBytes(0) = %q, want 未知大小", got)
	}
	if got := formatBytes(500); got != "500 B" {
		t.Errorf("formatBytes(500) = %q, want 500 B", got)
	}
	if got := formatBytes(2048); got != "2.00 KB" {
		t.Errorf("formatBytes(2048) = %q, want 2.00 KB", got)
	}
	if got := formatBytes(5242880); got != "5.00 MB" {
		t.Errorf("formatBytes(5242880) = %q, want 5.00 MB", got)
	}
}

type fakeExternalTG struct {
	sentTexts   []string
	sentButtons [][][]tgclient.Button
	editedTexts []string
	answers     []string
}

func (f *fakeExternalTG) Run(_ context.Context) error                          { return nil }
func (f *fakeExternalTG) SelfID() int64                                         { return 999 }
func (f *fakeExternalTG) SendMessage(_ context.Context, _ int64, text string) error {
	f.sentTexts = append(f.sentTexts, text)
	return nil
}
func (f *fakeExternalTG) SendMessageWithID(_ context.Context, _ int64, text string) (int, error) {
	f.sentTexts = append(f.sentTexts, text)
	return len(f.sentTexts), nil
}
func (f *fakeExternalTG) SendWithButtons(_ context.Context, _ int64, text string, buttons [][]tgclient.Button) error {
	f.sentTexts = append(f.sentTexts, text)
	f.sentButtons = append(f.sentButtons, buttons)
	return nil
}
func (f *fakeExternalTG) SendWithButtonsAndID(_ context.Context, _ int64, text string, buttons [][]tgclient.Button) (int, error) {
	f.sentTexts = append(f.sentTexts, text)
	f.sentButtons = append(f.sentButtons, buttons)
	return len(f.sentTexts), nil
}
func (f *fakeExternalTG) EditMessage(_ context.Context, _ int64, _ int, text string) error {
	f.editedTexts = append(f.editedTexts, text)
	return nil
}
func (f *fakeExternalTG) EditWithButtons(_ context.Context, _ int64, _ int, text string, _ [][]tgclient.Button) error {
	f.editedTexts = append(f.editedTexts, text)
	return nil
}
func (f *fakeExternalTG) AnswerCallback(_ context.Context, _ int64, text string, _ bool) error {
	f.answers = append(f.answers, text)
	return nil
}
func (f *fakeExternalTG) DeleteMessages(_ context.Context, _ int64, _ []int64) error {
	return nil
}
func (f *fakeExternalTG) WaitReady(_ context.Context) error { return nil }
func (f *fakeExternalTG) RegisterBotCommands(_ context.Context, _ int64) error { return nil }

func TestHandleExternalURLMessage_Flow(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	repo := &fakeRepo{}
	drives := boundDrive()
	tg := &fakeExternalTG{}

	authorizer := &fakeAuthorizer{
		perms: map[string]map[auth.Action]bool{
			"1001": {auth.ActionExternalLink: true},
			"2002": {auth.ActionExternalLink: false},
		},
	}

	app := newTestLinkApp(repo, drives, nil, &linkMockNotices{})
	app.tg = tg
	app.notifier = tg
	app.notices = tg
	app.auth = authorizer
	app.bindSessions = bindingsession.NewStore(rdb)
	app.probeURL = func(_ context.Context, targetURL string, _ int64) (*externalSourceInfo, error) {
		return &externalSourceInfo{
			URL:         targetURL,
			FinalURL:    targetURL,
			DisplayURL:  targetURL,
			FileName:    "archive.tar.gz",
			FileSize:    1048576,
			ContentType: "application/gzip",
		}, nil
	}

	// 1. Unsupported link
	handled := app.handleExternalURLMessage(context.Background(), messageInfo{
		ChatID:   123,
		SenderID: 1001,
		Text:     "magnet:?xt=urn:btih:xyz",
	})
	if !handled {
		t.Fatal("expected unsupported scheme to be handled")
	}
	if len(tg.sentTexts) == 0 || !strings.Contains(tg.sentTexts[0], "暂不支持这个链接") {
		t.Fatalf("expected unsupported message, got %v", tg.sentTexts)
	}

	// 2. Permission denied for user 2002
	tg.sentTexts = nil
	handled = app.handleExternalURLMessage(context.Background(), messageInfo{
		ChatID:   123,
		SenderID: 2002,
		Text:     "https://example.com/test.zip",
	})
	if !handled {
		t.Fatal("expected permission denied to be handled")
	}
	if len(tg.sentTexts) == 0 || !strings.Contains(tg.sentTexts[0], "外部链接离线下载暂未开放") {
		t.Fatalf("expected admin only message, got %v", tg.sentTexts)
	}

	// 3. Valid external URL -> creates session and confirmation prompt
	tg.sentTexts = nil
	tg.sentButtons = nil
	handled = app.handleExternalURLMessage(context.Background(), messageInfo{
		ChatID:   123,
		SenderID: 1001,
		Text:     "https://example.com/archive.tar.gz",
	})
	if !handled {
		t.Fatal("expected external URL to be handled")
	}
	if len(tg.sentTexts) == 0 || !strings.Contains(tg.sentTexts[0], "确认离线下载外部链接") {
		t.Fatalf("expected confirmation message, got %v", tg.sentTexts)
	}
	if len(tg.sentButtons) == 0 || len(tg.sentButtons[0]) == 0 {
		t.Fatalf("expected inline buttons for confirmation")
	}

	// Verify session
	sess, err := app.bindSessions.Get(context.Background(), "1001")
	if err != nil || sess == nil || sess.CurrentStep != "EXTERNAL_URL_CONFIRM" {
		t.Fatalf("expected session EXTERNAL_URL_CONFIRM, got: %v", sess)
	}
	nonce := sess.Data["nonce"]
	if nonce == "" {
		t.Fatal("expected non-empty nonce")
	}

	// 4. Cancel callback
	cbCancel := tgclient.CallbackContext{
		ChatID:     123,
		UserID:     1001,
		MsgID:      456,
		CallbackID: 789,
	}
	err = app.handleExternalURLCallback(context.Background(), cbCancel, "external_url_cancel_"+nonce)
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.editedTexts) == 0 || !strings.Contains(tg.editedTexts[0], "下载已取消") {
		t.Fatalf("expected cancelled edit text, got %v", tg.editedTexts)
	}

	// Session should be cleared
	sess, err = app.bindSessions.Get(context.Background(), "1001")
	if err != nil || sess != nil {
		t.Fatalf("session should be cleared after cancel, got %v", sess)
	}

	// 5. Confirm execute flow
	tg.sentTexts = nil
	tg.editedTexts = nil
	handled = app.handleExternalURLMessage(context.Background(), messageInfo{
		ChatID:   123,
		SenderID: 1001,
		Text:     "https://example.com/archive.tar.gz",
	})
	if !handled {
		t.Fatal("expected external URL to be handled")
	}
	sess, _ = app.bindSessions.Get(context.Background(), "1001")
	newNonce := sess.Data["nonce"]

	cbExecute := tgclient.CallbackContext{
		ChatID:     123,
		UserID:     1001,
		MsgID:      456,
		CallbackID: 789,
	}
	err = app.handleExternalURLCallback(context.Background(), cbExecute, "external_url_execute_"+newNonce)
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.editedTexts) == 0 || !strings.Contains(tg.editedTexts[0], "已创建外部链接任务") {
		t.Fatalf("expected task created edit text, got %v", tg.editedTexts)
	}

	// Verify task created in repo
	if len(repo.created) == 0 {
		t.Fatal("expected task created in repo")
	}
	createdTask := repo.created[len(repo.created)-1]
	if createdTask.SourceType != "external_url" {
		t.Errorf("task SourceType = %q, want external_url", createdTask.SourceType)
	}
	if !createdTask.FileName.Valid || createdTask.FileName.String != "archive.tar.gz" {
		t.Errorf("task FileName = %v, want archive.tar.gz", createdTask.FileName)
	}
	if createdTask.FileSize != 1048576 {
		t.Errorf("task FileSize = %d, want 1048576", createdTask.FileSize)
	}
}

type fakeAuthorizer struct {
	perms map[string]map[auth.Action]bool
}

func (f *fakeAuthorizer) Can(_ context.Context, userID string, action auth.Action) (bool, error) {
	if userPerms, ok := f.perms[userID]; ok {
		return userPerms[action], nil
	}
	return false, nil
}
func (f *fakeAuthorizer) IsBanned(context.Context, string) (bool, error) {
	return false, nil
}
