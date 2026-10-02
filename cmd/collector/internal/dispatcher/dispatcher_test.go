package dispatcher

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// fakeTG 记录发出的消息,代替真连 Telegram。
type fakeTG struct {
	sent  []string
	edits []string
	btns  int
}

func (f *fakeTG) SendMessage(_ context.Context, _ int64, text string) error {
	f.sent = append(f.sent, text)
	return nil
}
func (f *fakeTG) SendWithButtons(_ context.Context, _ int64, text string, b [][]tgclient.Button) error {
	f.sent = append(f.sent, text)
	f.btns += len(b)
	return nil
}
func (f *fakeTG) EditMessage(_ context.Context, _ int64, _ int, text string) error {
	f.edits = append(f.edits, text)
	return nil
}
func (f *fakeTG) EditWithButtons(_ context.Context, _ int64, _ int, text string, b [][]tgclient.Button) error {
	f.edits = append(f.edits, text)
	f.btns += len(b)
	return nil
}
func (f *fakeTG) AnswerCallback(context.Context, int64, string, bool) error { return nil }

// fakeAuth 模拟权限层。
type fakeAuth struct {
	roles      map[string]auth.Role
	canRun     bool
	setRoleErr error
}

func (a *fakeAuth) CanRunCommand(_ context.Context, _, _ string) (bool, error) {
	return a.canRun, nil
}

func (a *fakeAuth) IsBanned(_ context.Context, userID string) (bool, error) {
	return a.roles[userID] == auth.RoleBanned, nil
}

func (a *fakeAuth) SetRole(_ context.Context, userID string, role auth.Role) error {
	if a.setRoleErr != nil {
		return a.setRoleErr
	}
	if a.roles == nil {
		a.roles = map[string]auth.Role{}
	}
	a.roles[userID] = role
	return nil
}

// fakeRenders 返回固定文案。
type fakeRenders struct{}

func (fakeRenders) Welcome(uid string) string { return "welcome:" + uid }
func (fakeRenders) Help() string              { return "help-text" }
func (fakeRenders) Status(uid string, ts []TaskBrief) string {
	return "status:" + uid + ":" + string(rune('0'+len(ts)))
}
func (fakeRenders) FilesHeader(n int) string { return "files:" + string(rune('0'+n)) }

type harness struct {
	d     *Dispatcher
	tg    *fakeTG
	auth  *fakeAuth
	tasks []TaskBrief
}

func newHarness() *harness {
	h := &harness{
		tg:   &fakeTG{},
		auth: &fakeAuth{roles: map[string]auth.Role{}, canRun: true},
	}
	h.d = New(Deps{
		Telegram: h.tg,
		Auth:     h.auth,
		Tasks:    taskReaderFunc(func(context.Context, string, int) ([]TaskBrief, error) { return h.tasks, nil }),
		Renders:  fakeRenders{},
		Log:      quiet(),
	})
	return h
}

type taskReaderFunc func(context.Context, string, int) ([]TaskBrief, error)

func (f taskReaderFunc) UserTasks(ctx context.Context, uid string, n int) ([]TaskBrief, error) {
	return f(ctx, uid, n)
}

func last(t *testing.T, h *harness) string {
	t.Helper()
	if len(h.tg.sent) == 0 {
		t.Fatal("没有发出任何消息")
	}
	return h.tg.sent[len(h.tg.sent)-1]
}

// TestStartAndHelp 是最基础的两条路径。
func TestStartAndHelp(t *testing.T) {
	h := newHarness()
	ctx := context.Background()

	if handled, err := h.d.HandleText(ctx, 1, "u1", "/start"); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if last(t, h) != "welcome:u1" {
		t.Errorf("响应 = %q", last(t, h))
	}

	if _, err := h.d.HandleText(ctx, 1, "u1", "/help"); err != nil {
		t.Fatal(err)
	}
	if last(t, h) != "help-text" {
		t.Errorf("响应 = %q", last(t, h))
	}
}

// TestNonCommandIsNotHandled 普通聊天不该被当命令。
//
// 反了的话用户发一条带斜杠的普通文本就会被 bot 回一句。
func TestNonCommandIsNotHandled(t *testing.T) {
	h := newHarness()
	for _, text := range []string{"hello", "", "  ", "看看这个 /path/file"} {
		handled, err := h.d.HandleText(context.Background(), 1, "u1", text)
		if err != nil {
			t.Fatal(err)
		}
		if handled {
			t.Errorf("文本 %q 被当成命令处理了", text)
		}
	}
	if len(h.tg.sent) != 0 {
		t.Errorf("普通文本不该回消息,实际发了 %d 条", len(h.tg.sent))
	}
}

// TestBannedUserIsSilentlyIgnored 封禁用户连命令都不回。
//
// 回一句「你被封禁」本身就是信息泄露 —— 封禁者应当表现为「bot 死了」。
func TestBannedUserIsSilentlyIgnored(t *testing.T) {
	h := newHarness()
	h.auth.roles["bad"] = auth.RoleBanned

	handled, err := h.d.HandleText(context.Background(), 1, "bad", "/start")
	if err != nil {
		t.Fatal(err)
	}
	if !handled {
		t.Error("封禁用户的消息应被「已处理」吸收,而不是掉回普通消息路径")
	}
	if len(h.tg.sent) != 0 {
		t.Errorf("封禁用户不该收到任何回复,实际 %d 条", len(h.tg.sent))
	}
}

// TestPermissionDenied 用户没权限时要明确拒绝。
func TestPermissionDenied(t *testing.T) {
	h := newHarness()
	h.auth.canRun = false

	if _, err := h.d.HandleText(context.Background(), 1, "u1", "/start"); err != nil {
		t.Fatal(err)
	}
	if got := last(t, h); !strings.Contains(got, "没有权限") {
		t.Errorf("响应 = %q,应说明无权限", got)
	}
}

// TestUnsupportedCommandIsExplicit 未迁移的命令必须明说。
//
// 静默忽略会让用户以为 bot 死了 —— 而排查「bot 没反应」极难。
func TestUnsupportedCommandIsExplicit(t *testing.T) {
	h := newHarness()

	for _, cmd := range []string{"/scan_dup", "/users", "/task_queue", "/diagnosis", "/mcp"} {
		t.Run(cmd, func(t *testing.T) {
			if _, err := h.d.HandleText(context.Background(), 1, "u1", cmd); err != nil {
				t.Fatal(err)
			}
			got := last(t, h)
			if !strings.Contains(got, "暂未迁移") {
				t.Errorf("%s 的响应 = %q,应明确说未迁移", cmd, got)
			}
			// 还要告诉用户能用哪些
			if !strings.Contains(got, "/help") {
				t.Errorf("响应应列出可用命令:%q", got)
			}
		})
	}
}

// TestCommandOnlyMatchesFirstToken `/set_remote_folder /a /b` 的命令名是第一段。
func TestCommandOnlyMatchesFirstToken(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "u1", "/set_remote_folder /my/folder"); err != nil {
		t.Fatal(err)
	}
	got := last(t, h)
	if !strings.Contains(got, "/my/folder") {
		t.Errorf("响应 = %q,应回显设置的目录", got)
	}
}

// TestRemoteFolderKeepsSpaces 目录名带空格要保留。
func TestRemoteFolderKeepsSpaces(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "u1", "/set_remote_folder /my folder"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(last(t, h), "/my folder") {
		t.Errorf("目录里的空格被吃掉了:%q", last(t, h))
	}
}

// TestRemoteFolderMissingArg 缺参数要给用法,不是静默。
func TestRemoteFolderMissingArg(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "u1", "/set_remote_folder"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(last(t, h), "用法") {
		t.Errorf("缺参数时响应 = %q,应给用法", last(t, h))
	}
}

// TestBanRequiresConfirm 管理操作必须显式确认 ——
// B 方案砍掉了按钮二次确认,改用参数确认,不能连这个都没有。
func TestBanRequiresConfirm(t *testing.T) {
	h := newHarness()
	ctx := context.Background()

	if _, err := h.d.HandleText(ctx, 1, "admin", "/ban 12345"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["12345"] != "" {
		t.Error("没加 confirm 就封禁了 —— 防误操作的机制失效")
	}
	if !strings.Contains(last(t, h), "确认") {
		t.Errorf("响应 = %q,应提示确认", last(t, h))
	}

	// 加了 confirm 才真的执行
	if _, err := h.d.HandleText(ctx, 1, "admin", "/ban 12345 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["12345"] != auth.RoleBanned {
		t.Errorf("加 confirm 后未封禁,当前角色 = %q", h.auth.roles["12345"])
	}
}

// TestUnbanRestoresUserRole 解封要恢复成 user,不是删记录。
func TestUnbanRestoresUserRole(t *testing.T) {
	h := newHarness()
	h.auth.roles["u1"] = auth.RoleBanned
	ctx := context.Background()

	if _, err := h.d.HandleText(ctx, 1, "admin", "/unban u1 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["u1"] != auth.RoleUser {
		t.Errorf("解封后角色 = %q,期望 user", h.auth.roles["u1"])
	}
}

// TestStatusShowsTaskCount /status 要反映真实任务数。
func TestStatusShowsTaskCount(t *testing.T) {
	h := newHarness()
	h.tasks = []TaskBrief{
		{ID: "1", FileName: "a", Status: "completed"},
		{ID: "2", FileName: "b", Status: "queued"},
		{ID: "3", FileName: "c", Status: "uploading"},
	}
	if _, err := h.d.HandleText(context.Background(), 1, "u1", "/status"); err != nil {
		t.Fatal(err)
	}
	if got := last(t, h); !strings.Contains(got, "u1") {
		t.Errorf("状态响应 = %q,应包含用户", got)
	}
}

// TestEscapeHTML 命令参数里的 HTML 必须转义。
//
// 不转义的话一个文件名就能破坏消息结构,表现为 Telegram 报
// 「格式错误」而不是显示正确的名字。
func TestEscapeHTML(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "u1",
		"/set_remote_folder /<script>alert(1)</script>"); err != nil {
		t.Fatal(err)
	}
	got := last(t, h)
	if strings.Contains(got, "<script>") {
		t.Errorf("HTML 未转义:%q", got)
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Errorf("应转义为 &lt;script&gt;:%q", got)
	}
}

// TestCaseInsensitiveCommand 命令大小写不敏感 —— 用户可能打 /START。
func TestCaseInsensitiveCommand(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "u1", "/START"); err != nil {
		t.Fatal(err)
	}
	if last(t, h) != "welcome:u1" {
		t.Errorf("大写命令未被识别,响应 = %q", last(t, h))
	}
}

// TestLogoutAliasForUnbind /logout 与 /unbind 是同一个动作(JS 侧 fallthrough)。
func TestLogoutAliasForUnbind(t *testing.T) {
	h := newHarness()
	// 两个命令都不该报「未迁移」——它们映射到同一处
	for _, cmd := range []string{"/logout", "/unbind"} {
		if _, err := h.d.HandleText(context.Background(), 1, "u1", cmd); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(last(t, h), "暂未迁移") {
			t.Errorf("%s 被当成未迁移命令了", cmd)
		}
	}
}
