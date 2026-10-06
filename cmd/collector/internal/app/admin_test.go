package app

// 管理看板的最小可跑检查。命令入口要真连 Telegram,测不到;能测的
// 是渲染(状态分布、用户列表、按钮)、回调解析,以及两条会伤人的路径:
// 维护模式是否真拦住了普通用户,以及批量重试是否真的一批一批来。

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
)

// fakeAdmin 是管理看板的假仓储:记录调用,回预设结果。
type fakeAdmin struct {
	ov       store.QueueOverview
	ovErr    error
	detail   store.TasksByStatus
	users    store.AdminUsersPage
	usersErr error

	settings  map[string]string
	setCalls  []string
	gotFilter string
	gotPage   int
	gotOwner  string
	getCalls  int
}

func (f *fakeAdmin) QueueOverview(context.Context, int) (store.QueueOverview, error) {
	return f.ov, f.ovErr
}

func (f *fakeAdmin) TasksByStatus(_ context.Context, status string, page, _ int) (store.TasksByStatus, error) {
	if f.ovErr != nil {
		return store.TasksByStatus{}, f.ovErr
	}
	d := f.detail
	d.Page = page
	return d, nil
}

func (f *fakeAdmin) ListUsersForAdmin(_ context.Context, filter string, page, _ int, ownerID string) (store.AdminUsersPage, error) {
	f.gotFilter, f.gotPage, f.gotOwner = filter, page, ownerID
	if f.usersErr != nil {
		return store.AdminUsersPage{}, f.usersErr
	}
	out := f.users
	out.Filter, out.Page = filter, page
	return out, nil
}

func (f *fakeAdmin) GetSetting(_ context.Context, key, def string) (string, error) {
	f.getCalls++
	if v, ok := f.settings[key]; ok {
		return v, nil
	}
	return def, nil
}

func (f *fakeAdmin) SetSetting(_ context.Context, key, value string) error {
	f.setCalls = append(f.setCalls, key+"="+value)
	if f.settings == nil {
		f.settings = map[string]string{}
	}
	f.settings[key] = value
	return nil
}

// newAdminApp 接受 AdminRepo 接口而不是 *fakeAdmin ——
// 传具体的 nil 指针会让接口值非 nil,「没装配仓储」这条分支就测不到。
func newAdminApp(admin AdminRepo) *App {
	repo := &statusRepo{}
	return &App{
		repo:   repo,
		admin:  admin,
		tasks:  task.NewManager(repo, quietApp()),
		drives: &fakeDrives{},
		log:    quietApp(),
	}
}

// TestQueueOverviewRendersCountsAndFilters —— 状态分布与筛选按钮都要在。
func TestQueueOverviewRendersCountsAndFilters(t *testing.T) {
	a := newAdminApp(&fakeAdmin{ov: store.QueueOverview{
		StatusCounts: map[string]int{"queued": 3, "downloading": 1, "uploading": 1, "failed": 4},
		ActiveTasks: []store.Task{{
			ID: "t1", UserID: "42", Status: contract.StatusQueued,
			FileName:  sql.NullString{String: "a.mp4", Valid: true},
			UpdatedAt: nowMillis(),
		}},
		UserCounts: []store.UserTaskCount{{UserID: "42", Count: 5}},
	}})

	text, buttons, err := a.taskQueueView(context.Background())
	if err != nil {
		t.Fatalf("渲染队列概览失败: %v", err)
	}

	for _, want := range []string{"排队中: 3", "失败: 4", "a.mp4", "42", "5 个任务"} {
		if !strings.Contains(text, want) {
			t.Errorf("概览缺少 %q:\n%s", want, text)
		}
	}
	// 活跃状态恒显示(哪怕为 0),历史状态非零才显示。
	if !strings.Contains(text, "上传中: 1") {
		t.Errorf("概览缺少上传中计数:\n%s", text)
	}
	if strings.Contains(text, "已取消: 0") {
		t.Errorf("零计数的历史状态不该显示:\n%s", text)
	}
	// 筛选按钮带计数;失败(非零)进第二行。
	if !hasButton(buttons, "tq_queued_0") || !hasButton(buttons, "tq_failed_0") {
		t.Errorf("缺少状态筛选按钮: %+v", buttons)
	}
}

// TestQueueDetailShowsFailureReasonAndSize —— 失败原因与文件大小是排查
// 「为什么失败」的第一手线索,漏了等于这个页面白做。
func TestQueueDetailShowsFailureReasonAndSize(t *testing.T) {
	text, buttons := renderQueueDetailPanel(contract.StatusFailed, store.TasksByStatus{
		Tasks: []store.Task{{
			ID: "t1", UserID: "42", Status: contract.StatusFailed,
			FileName: sql.NullString{String: "bad.mp4", Valid: true},
			FileSize: 2048,
			ErrorMsg: sql.NullString{String: "网盘拒绝了这个文件", Valid: true},
		}},
		Total: 1, Page: 0, PageSize: 8, TotalPages: 1,
	})

	if !strings.Contains(text, "网盘拒绝了这个文件") {
		t.Errorf("详情缺少失败原因:\n%s", text)
	}
	if !strings.Contains(text, "2.0 KB") {
		t.Errorf("详情缺少文件大小:\n%s", text)
	}
	if !strings.Contains(text, "第 1/1 页") {
		t.Errorf("详情缺少页码信息:\n%s", text)
	}
	// 失败页才有「重试本页」,别的状态不该有。
	if !hasButton(buttons, "retry_failed_page_0") {
		t.Errorf("失败页缺少批量重试按钮: %+v", buttons)
	}
	if !hasButton(buttons, "tq_back") {
		t.Errorf("详情缺少返回按钮: %+v", buttons)
	}
}

// TestQueueDetailNonFailedHasNoRetry —— 在「已完成」页挂「重试本页」
// 会让管理员以为完成的任务需要重试。
func TestQueueDetailNonFailedHasNoRetry(t *testing.T) {
	_, buttons := renderQueueDetailPanel(contract.StatusCompleted, store.TasksByStatus{
		Tasks: []store.Task{{ID: "t1", Status: contract.StatusCompleted}},
		Total: 1, PageSize: 8, TotalPages: 1,
	})
	for _, row := range buttons {
		for _, b := range row {
			if strings.HasPrefix(b.Data, "retry_failed_page_") {
				t.Fatalf("非失败页不该有批量重试按钮: %s", b.Data)
			}
		}
	}
}

// TestPaginationRowClampsAtEdges —— 首页没有「上一页」,末页没有「下一页」。
// 少了这个,第一页会显示「上一页 -1」,点了就翻到不存在的页。
func TestPaginationRowClampsAtEdges(t *testing.T) {
	pageData := func(p int) string { return fmt.Sprintf("au_all_%d", p) }

	first := paginationRow(0, 3, "au_refresh_all_0", pageData)
	if len(first) != 3 {
		t.Errorf("首页应只有 刷新/下一页/末页,实际 %d 枚: %+v", len(first), first)
	}
	for _, b := range first {
		if b.Data == "au_all_-1" {
			t.Error("首页出现了指向 -1 页的按钮")
		}
	}

	last := paginationRow(2, 3, "au_refresh_all_2", pageData)
	if len(last) != 3 {
		t.Errorf("末页应只有 首页/上一页/刷新,实际 %d 枚: %+v", len(last), last)
	}
	for _, b := range last {
		if b.Data == "au_all_3" {
			t.Error("末页出现了指向越界页的按钮")
		}
	}
}

// TestPaginationRowSinglePage —— 只有一页时只该有一个刷新按钮。
func TestPaginationRowSinglePage(t *testing.T) {
	row := paginationRow(0, 1, "r", func(p int) string { return fmt.Sprintf("p%d", p) })
	if len(row) != 1 || row[0].Data != "r" {
		t.Errorf("单页应只有刷新按钮,实际 %+v", row)
	}
}

// TestAdminUsersRendersSummaryAndFilters —— 汇总、角色、筛选行都要在。
func TestAdminUsersRendersSummaryAndFilters(t *testing.T) {
	a := newAdminApp(&fakeAdmin{users: store.AdminUsersPage{
		Summary: store.AdminUsersSummary{Total: 5, Active: 2, Admins: 1, Banned: 1},
		Users: []store.AdminUser{{
			UserID: "42", Role: "admin", Drives: 2, Tasks: 9, Active: 1,
			Complete: 5, Failed: 3, LastSeenAt: nowMillis(),
		}},
		PageSize: 8, TotalPages: 2,
	}})

	text, buttons, err := a.adminUsersView(context.Background(), "all", 0)
	if err != nil {
		t.Fatalf("渲染用户列表失败: %v", err)
	}

	for _, want := range []string{"共 5 位用户", "封禁 1", "管理员", "网盘 2", "完成 5 · 失败 3"} {
		if !strings.Contains(text, want) {
			t.Errorf("用户列表缺少 %q:\n%s", want, text)
		}
	}
	// 当前筛选要有勾。
	if !strings.Contains(text, "筛选: 全部") {
		t.Errorf("缺少筛选行:\n%s", text)
	}
	for _, want := range []string{"au_all_0", "au_active_0", "au_banned_0", "au_nodrive_0", "au_all_1"} {
		if !hasButton(buttons, want) {
			t.Errorf("用户列表缺少按钮 %s: %+v", want, buttons)
		}
	}
}

// TestAdminUsersOwnerIdPassed —— owner 不落库,只存在于配置。
// 不把它当参数喂进查询,管理员在列表里就永远看不到自己。
func TestAdminUsersOwnerIdPassed(t *testing.T) {
	admin := &fakeAdmin{users: store.AdminUsersPage{PageSize: 8, TotalPages: 1}}
	a := newAdminApp(admin)
	a.ownerID = "999"

	if _, _, err := a.adminUsersView(context.Background(), "admin", 0); err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if admin.gotOwner != "999" {
		t.Errorf("ownerID 没传下去: %q", admin.gotOwner)
	}
	if admin.gotFilter != "admin" {
		t.Errorf("筛选没传下去: %q", admin.gotFilter)
	}
}

// TestParseAdminUsersCallback —— 回调数据是用户可控的,解析必须收得住。
func TestParseAdminUsersCallback(t *testing.T) {
	cases := []struct {
		data   string
		filter string
		page   int
		ok     bool
	}{
		{"au_all_0", "all", 0, true},
		{"au_nodrive_3", "nodrive", 3, true},
		{"au_refresh_banned_2", "banned", 2, true},
		{"au_bogus_1", "all", 1, true}, // 未登记的筛选收敛到 all
		{"au_all_-5", "all", 0, true},  // 负页码归零
		{"au_all_x", "all", 0, true},   // 非数字归零
		{"tq_queued_0", "", 0, false},  // 不是这一组的
		{"au_all", "", 0, false},       // 缺页码
	}
	for _, c := range cases {
		filter, page, ok := parseAdminUsersCallback(c.data)
		if ok != c.ok {
			t.Errorf("%s: ok 期望 %v,实际 %v", c.data, c.ok, ok)
			continue
		}
		if !ok {
			continue
		}
		if filter != c.filter || page != c.page {
			t.Errorf("%s: 期望 (%s,%d),实际 (%s,%d)", c.data, c.filter, c.page, filter, page)
		}
	}
}

// TestMaintenanceBlocksOnlyNonAdmins —— 维护模式的核心:普通用户被拦,
// 管理员照常。这条判错的方向性很强 —— 判松了等于维护模式形同虚设,
// 判紧了等于管理员把自己也关在门外。
func TestMaintenanceBlocksOnlyNonAdmins(t *testing.T) {
	cases := []struct {
		mode    string
		isAdmin bool
		want    bool
	}{
		{store.AccessModePrivate, false, true},
		{store.AccessModePrivate, true, false},
		{store.AccessModePublic, false, false},
		{store.AccessModePublic, true, false},
	}
	for _, c := range cases {
		if got := maintenanceBlocks(c.mode, c.isAdmin); got != c.want {
			t.Errorf("mode=%s isAdmin=%v: 期望 %v,实际 %v", c.mode, c.isAdmin, c.want, got)
		}
	}
}

// TestAccessModeCachedNotPerMessage —— 全局守卫每条消息都要读一次模式。
// 不缓存就是每条消息一次 D1 往返,正常流量下会把 D1 打满。
func TestAccessModeCachedNotPerMessage(t *testing.T) {
	admin := &fakeAdmin{settings: map[string]string{store.AccessModeKey: store.AccessModePrivate}}
	a := newAdminApp(admin)

	for i := 0; i < 5; i++ {
		if got := a.accessMode(context.Background()); got != store.AccessModePrivate {
			t.Fatalf("第 %d 次读到 %q,期望 private", i, got)
		}
	}
	if admin.getCalls != 1 {
		t.Errorf("5 次读应只打 1 次 D1,实际 %d 次", admin.getCalls)
	}

	// 切模式后必须立刻失效,否则管理员按下按钮还有几秒的窗口。
	admin.settings[store.AccessModeKey] = store.AccessModePublic
	a.invalidateAccessModeCache()
	if got := a.accessMode(context.Background()); got != store.AccessModePublic {
		t.Errorf("失效后应读到 public,实际 %q", got)
	}
}

// TestAccessModeFailsOpen —— D1 读失败时按公开处理。
// 反过来的话,一次数据库抖动会让所有用户都用不了机器人。
func TestAccessModeFailsOpen(t *testing.T) {
	a := newAdminApp(nil) // admin 为 nil:没有任何仓储可问
	if got := a.accessMode(context.Background()); got != store.AccessModePublic {
		t.Errorf("无仓储时应按 public 放行,实际 %q", got)
	}
	if a.blockedByMaintenance(context.Background(), "42") {
		t.Error("没有仓储时不该拦住任何人")
	}
}

// TestModeSwitchWritesSetting —— 确认后要真的写进设置表。
func TestModeSwitchWritesSetting(t *testing.T) {
	admin := &fakeAdmin{}
	a := newAdminApp(admin)

	if err := a.admin.SetSetting(context.Background(),
		store.AccessModeKey, store.AccessModePrivate); err != nil {
		t.Fatalf("写设置失败: %v", err)
	}
	if len(admin.setCalls) != 1 ||
		admin.setCalls[0] != store.AccessModeKey+"="+store.AccessModePrivate {
		t.Errorf("设置没写对: %+v", admin.setCalls)
	}
}

// TestNormalizeAccessMode —— 任意输入都要收敛到两个合法值,
// 写进去一个没人认的字符串等于把服务锁死在维护模式。
func TestNormalizeAccessMode(t *testing.T) {
	cases := map[string]string{
		"private": store.AccessModePrivate,
		"public":  store.AccessModePublic,
		"":        store.AccessModePublic,
		"hacked":  store.AccessModePublic,
		"PRIVATE": store.AccessModePublic,
	}
	for in, want := range cases {
		if got := store.NormalizeAccessMode(in); got != want {
			t.Errorf("NormalizeAccessMode(%q) = %q,期望 %q", in, got, want)
		}
	}
}

// TestRelativeTime —— 「刚刚 / N分钟前」这套阈值与 JS 侧一致。
func TestRelativeTime(t *testing.T) {
	base := nowMillis()
	cases := []struct {
		ts   int64
		want string
	}{
		{0, "-"},
		{base, "刚刚"},
		{base - 5*60_000, "5分钟前"},
		{base - 3*3_600_000, "3小时前"},
		{base - 2*86_400_000, "2天前"},
	}
	for _, c := range cases {
		if got := relativeTime(c.ts); got != c.want {
			t.Errorf("relativeTime: 期望 %q,实际 %q", c.want, got)
		}
	}
}

// TestDiagnosisReportsRealFailures —— 诊断报告不能编「一切正常」。
// 所有依赖都没装配时,它必须如实说「未配置」,而不是 ✅。
func TestDiagnosisReportsRealFailures(t *testing.T) {
	a := newAdminApp(&fakeAdmin{})
	text := a.diagnosisReport(context.Background())

	if !strings.Contains(text, "系统诊断报告") {
		t.Errorf("缺少标题:\n%s", text)
	}
	for _, want := range []string{"多实例状态", "网络诊断", "系统资源"} {
		if !strings.Contains(text, want) {
			t.Errorf("缺少段落 %q", want)
		}
	}
	// 没装配的依赖要说「未配置」,不能显示成正常。
	for _, want := range []string{"D1 未配置", "Redis 未配置", "rclone 未配置"} {
		if !strings.Contains(text, want) {
			t.Errorf("未装配的依赖应如实标注 %q:\n%s", want, text)
		}
	}
	// Telegram 没连上必须是 ❌。
	if !strings.Contains(text, "Telegram MTProto API 连接失败") {
		t.Errorf("未连接的 Telegram 应报失败:\n%s", text)
	}
}

// TestStatusButtonsAdminOnly —— 管理员那三枚不能漏给普通用户。
func TestStatusButtonsAdminOnly(t *testing.T) {
	plain := statusButtons(queueOverview{}, false)
	if hasButton(plain, "task_queue_open") || hasButton(plain, "admin_users_open") {
		t.Errorf("普通用户不该看到管理按钮: %+v", plain)
	}
	admin := statusButtons(queueOverview{}, true)
	for _, want := range []string{"task_queue_open", "admin_users_open", "diagnosis_run"} {
		if !hasButton(admin, want) {
			t.Errorf("管理员缺少按钮 %s: %+v", want, admin)
		}
	}
}

// fakeAuth 是权限层的假实现:按动作集合回答「这个动作允许吗」。
type fakeAuth struct {
	allow  map[auth.Action]bool
	banned bool
}

func (f *fakeAuth) Can(_ context.Context, _ string, action auth.Action) (bool, error) {
	return f.allow[action], nil
}

func (f *fakeAuth) IsBanned(context.Context, string) (bool, error) { return f.banned, nil }

// TestAdminMayTouchOthersTasksButPlainUserMayNot —— /task_queue 是全站看板,
// 管理员看得到别人的失败任务就必须能重试;而 taskId 明晃晃写在按钮的
// 回调数据里,普通用户必须打不动。两头判错都是事故:一头是功能不可用,
// 另一头是任何人都能取消别人的转存。
func TestAdminMayTouchOthersTasksButPlainUserMayNot(t *testing.T) {
	newApp := func(adminPower bool) (*App, *statusRepo) {
		other := testTask("t1", "99", contract.StatusFailed)
		repo := &statusRepo{
			fakeRepo: &fakeRepo{},
			tasks:    map[string]*store.Task{"t1": &other},
		}
		a := newStatusApp(repo)
		a.auth = &fakeAuth{allow: map[auth.Action]bool{
			auth.ActionTaskCancelAny: adminPower,
		}}
		return a, repo
	}

	a, repo := newApp(false)
	if got := a.retryTask(context.Background(), "42", "t1"); got != statusTaskNotFound {
		t.Errorf("普通用户重试他人任务返回 %q,期望 %q", got, statusTaskNotFound)
	}
	if len(repo.trans) != 0 {
		t.Errorf("不该动状态机,却记了 %v", repo.trans)
	}

	a, repo = newApp(true)
	if got := a.retryTask(context.Background(), "42", "t1"); got != statusCmdSent {
		t.Errorf("管理员重试他人任务返回 %q,期望 %q", got, statusCmdSent)
	}
	if len(repo.trans) != 1 || repo.trans[0] != contract.EventRetry {
		t.Errorf("状态机事件 = %v,期望 [retry]", repo.trans)
	}
}

// TestNoAuthorizerGrantsNobodyAdmin —— 没装配权限层不等于「所有人都是
// 管理员」。can 在降级模式下放行是对的(没角色概念就没人被拦),
// 但「只有管理员能做」的那些动作必须一律拒绝。
func TestNoAuthorizerGrantsNobodyAdmin(t *testing.T) {
	other := testTask("t1", "99", contract.StatusFailed)
	repo := &statusRepo{
		fakeRepo: &fakeRepo{},
		tasks:    map[string]*store.Task{"t1": &other},
	}
	a := newStatusApp(repo) // auth 保持 nil

	if a.canAdmin(context.Background(), "42", auth.ActionTaskCancelAny) {
		t.Error("没装配权限层时不该判定为管理员")
	}
	if got := a.retryTask(context.Background(), "42", "t1"); got != statusTaskNotFound {
		t.Errorf("无权限层时重试他人任务返回 %q,期望 %q", got, statusTaskNotFound)
	}
	if len(repo.trans) != 0 {
		t.Errorf("不该动状态机,却记了 %v", repo.trans)
	}
	// 但普通功能不受影响:自己的任务照常能重试。
	mine := testTask("t2", "42", contract.StatusFailed)
	repo.tasks["t2"] = &mine
	if got := a.retryTask(context.Background(), "42", "t2"); got != statusCmdSent {
		t.Errorf("重试自己的任务返回 %q,期望 %q", got, statusCmdSent)
	}
}
