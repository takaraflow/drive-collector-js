package dispatcher

import (
	"context"
	"errors"
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
	ownerID    string
}

func (a *fakeAuth) CanRunCommand(_ context.Context, _, _ string) (bool, error) {
	return a.canRun, nil
}

// OwnerID 让 owner id 只存在于权限层一个地方 —— 与 *auth.Guard 同源。
// 之前 owner id 是 Deps 上的独立字段,测试填了、生产忘了,于是
// ownerOnly 那道闸把 owner 自己挡在门外。
func (a *fakeAuth) OwnerID() string { return a.ownerID }

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

func (fakeRenders) Welcome(uid string) string           { return "welcome:" + uid }
func (fakeRenders) Help(context.Context, string) string { return "help-text" }

type harness struct {
	d        *Dispatcher
	tg       *fakeTG
	auth     *fakeAuth
	sessions *fakeSessions
}

// fakeSessions 记录被清理过的用户。
type fakeSessions struct {
	cleared []string
	err     error
	// killed 是 CancelUserTasks 要掐的用户,count 是它回报的条数。
	killed []string
	count  int
}

func (f *fakeSessions) ClearUserSessions(_ context.Context, userID string) error {
	f.cleared = append(f.cleared, userID)
	return f.err
}

func (f *fakeSessions) CancelUserTasks(_ context.Context, userID string) int {
	f.killed = append(f.killed, userID)
	return f.count
}

func newHarness() *harness {
	h := &harness{
		tg:       &fakeTG{},
		auth:     &fakeAuth{roles: map[string]auth.Role{}, canRun: true, ownerID: "owner"},
		sessions: &fakeSessions{},
	}
	h.d = New(Deps{
		Telegram: h.tg,
		Auth:     h.auth,
		Renders:  fakeRenders{},
		Log:      quiet(),
		Sessions: h.sessions,
	})
	return h
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

// TestProAdminOwnerOnly —— 升降管理员只有 owner 能做。
//
// CommandPermissions 里 /pro_admin 要 ActionUserManage,那是 admin 也有的;
// 不在这之上再挡一道,任何 admin 都能给自己升官。
func TestProAdminOwnerOnly(t *testing.T) {
	ctx := context.Background()

	h := newHarness()
	if _, err := h.d.HandleText(ctx, 1, "admin", "/pro_admin 12345 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["12345"] != "" {
		t.Errorf("admin 给自己升了官,当前角色 = %q", h.auth.roles["12345"])
	}
	if !strings.Contains(last(t, h), "权限") {
		t.Errorf("响应 = %q,应报无权限", last(t, h))
	}

	o := newHarness()
	if _, err := o.d.HandleText(ctx, 1, "owner", "/pro_admin 12345 confirm"); err != nil {
		t.Fatal(err)
	}
	if o.auth.roles["12345"] != auth.RoleAdmin {
		t.Errorf("owner 下令后未升为管理员,当前角色 = %q", o.auth.roles["12345"])
	}
}

// TestDeAdminRestoresUserRole 取消管理员要落回 user —— 与 JS removeRole
// (删记录、回落到默认角色)等价。
func TestDeAdminRestoresUserRole(t *testing.T) {
	h := newHarness()
	h.auth.roles["u1"] = auth.RoleAdmin

	if _, err := h.d.HandleText(context.Background(), 1, "owner", "/de_admin u1 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["u1"] != auth.RoleUser {
		t.Errorf("取消管理员后角色 = %q,应为 user", h.auth.roles["u1"])
	}
}

// TestProAdminRequiresConfirm —— 和 /ban 一样,防误操作的参数确认不能少。
func TestProAdminRequiresConfirm(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "owner", "/pro_admin 12345"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["12345"] != "" {
		t.Error("没加 confirm 就授予了管理员")
	}
}

// TestBanOwner —— 不能封禁 owner(JS 侧 cannot_ban_owner)。
//
// owner 由配置决定、SetRole 对它写了也不生效,但命令会回「✅ 已封禁」:
// 用户以为封住了其实没封,库里还多一行脏数据。
func TestBanOwner(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "admin", "/ban owner confirm"); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.auth.roles["owner"]; ok {
		t.Errorf("owner 被写进了角色表,roles = %v", h.auth.roles)
	}
	if !strings.Contains(last(t, h), "所有者") {
		t.Errorf("响应 = %q,应拒绝封禁 owner", last(t, h))
	}
}

// TestBanClearsSessions —— 封禁成功后要清掉该用户的会话。
//
// 绑定会话里存着邮箱密码(TempData),封了人不删等于把凭据挂在
// Redis 里到过期。与 JS 侧 SessionManager.clear 同一步。
func TestBanClearsSessions(t *testing.T) {
	h := newHarness()
	if _, err := h.d.HandleText(context.Background(), 1, "admin", "/ban u9 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["u9"] != auth.RoleBanned {
		t.Fatalf("u9 未被封禁,roles = %v", h.auth.roles)
	}
	if len(h.sessions.cleared) != 1 || h.sessions.cleared[0] != "u9" {
		t.Errorf("会话清理 = %v,应为 [u9]", h.sessions.cleared)
	}
}

// TestBanKillsRunningTasks —— 封禁要掐掉该用户在跑的任务。
//
// 封了人却让他的文件继续往网盘传,等于封禁没生效。回执里也要说明
// 掐了几条,否则被封的人会以为已经停了。
func TestBanKillsRunningTasks(t *testing.T) {
	h := newHarness()
	h.sessions.count = 2
	if _, err := h.d.HandleText(context.Background(), 1, "admin", "/ban u9 confirm"); err != nil {
		t.Fatal(err)
	}
	if len(h.sessions.killed) != 1 || h.sessions.killed[0] != "u9" {
		t.Errorf("掐任务 = %v,应为 [u9]", h.sessions.killed)
	}
	if !strings.Contains(last(t, h), "2") {
		t.Errorf("回执没提掐掉几条: %q", last(t, h))
	}
}

// TestUnbanKeepsSessions —— 解封不清会话。
//
// 解封只是把角色改回 user,之前删掉的东西没理由在这里补:用户
// 重新走一遍绑定就行,悄悄重建旧会话反而可能带进过期凭据。解封同理
// 不该去「恢复」任务 —— 那些任务已经被掐了,重新排队是另一件事。
func TestUnbanKeepsSessions(t *testing.T) {
	h := newHarness()
	h.auth.roles["u9"] = auth.RoleBanned
	if _, err := h.d.HandleText(context.Background(), 1, "admin", "/unban u9 confirm"); err != nil {
		t.Fatal(err)
	}
	if len(h.sessions.cleared) != 0 {
		t.Errorf("解封时不该清会话,却清了 %v", h.sessions.cleared)
	}
	if len(h.sessions.killed) != 0 {
		t.Errorf("解封时不该掐任务,却掐了 %v", h.sessions.killed)
	}
}

// TestBanSessionErrorDoesNotUndoRole —— 清理失败不能改口说「失败」。
//
// 角色已经落库了,这时报失败会让管理员以为没封上而重发一遍。
// 残留会话最坏是过期,谎报才是真问题。
func TestBanSessionErrorDoesNotUndoRole(t *testing.T) {
	h := newHarness()
	h.sessions.err = errors.New("redis 挂了")
	if _, err := h.d.HandleText(context.Background(), 1, "admin", "/ban u9 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["u9"] != auth.RoleBanned {
		t.Errorf("清理失败不该回滚角色,roles = %v", h.auth.roles)
	}
	if !strings.Contains(last(t, h), "已封禁") {
		t.Errorf("响应 = %q,应仍报封禁成功", last(t, h))
	}
}

// TestOwnerOnlyFailsClosedWithoutOwnerID —— 没配 OWNER_ID 时,
// ownerOnly 的命令对所有人关闭。
//
// 防的是把 ownerID 默认为「无」后误放行:那样任何人都能升管理员。
// 真实事故是反过来的 —— owner id 漏装配导致 owner 自己被拒。
func TestOwnerOnlyFailsClosedWithoutOwnerID(t *testing.T) {
	h := newHarness()
	h.auth.ownerID = ""
	if _, err := h.d.HandleText(context.Background(), 1, "admin", "/pro_admin u1 confirm"); err != nil {
		t.Fatal(err)
	}
	if h.auth.roles["u1"] != "" {
		t.Errorf("无 owner 配置时仍升了官,roles = %v", h.auth.roles)
	}
}
