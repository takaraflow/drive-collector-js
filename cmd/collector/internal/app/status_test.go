package app

// /status 的最小可跑检查。命令入口要真连 Telegram,测不到;能测的
// 是渲染(队列计数、活跃任务、按钮)和「能不能取消别人的任务」。

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// hasButton 按钮树里有没有这枚 data。
func hasButton(buttons [][]tgclient.Button, data string) bool {
	for _, row := range buttons {
		for _, b := range row {
			if b.Data == data {
				return true
			}
		}
	}
	return false
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }

// statusRepo 借用 fakeRepo 满足 TaskRepo,只覆写 /status 真正读的三样。
type statusRepo struct {
	*fakeRepo
	counts map[string]int
	active []store.Task
	recent []store.Task
	tasks  map[string]*store.Task
}

func (r *statusRepo) CountByUserStatus(context.Context, string) (map[string]int, error) {
	return r.counts, nil
}

func (r *statusRepo) FindActiveByUserId(context.Context, string, int) ([]store.Task, error) {
	return r.active, nil
}

func (r *statusRepo) FindByUserId(context.Context, string, int) ([]store.Task, error) {
	return r.recent, nil
}

func (r *statusRepo) FindById(_ context.Context, id string) (*store.Task, error) {
	return r.tasks[id], nil
}

func newStatusApp(repo *statusRepo) *App {
	return &App{
		repo:   repo,
		tasks:  task.NewManager(repo, quietApp()),
		drives: &fakeDrives{},
		log:    quietApp(),
	}
}

func testTask(id, userID string, status contract.TaskStatus) store.Task {
	return store.Task{
		ID: id, UserID: userID, Status: status,
		FileName: sql.NullString{String: "movie.mp4", Valid: true},
	}
}

// TestStatusGeneralShowsQueueAndButtons —— 队列计数、活跃任务、按钮三样都要在。
func TestStatusGeneralShowsQueueAndButtons(t *testing.T) {
	repo := &statusRepo{
		fakeRepo: &fakeRepo{},
		counts:   map[string]int{"queued": 2, "downloading": 1, "completed": 7},
		active:   []store.Task{testTask("t1", "42", contract.StatusDownloading)},
		recent:   []store.Task{testTask("t9", "42", contract.StatusFailed)},
		tasks:    map[string]*store.Task{},
	}
	a := newStatusApp(repo)

	text, buttons, err := a.statusView(context.Background(), "42", "general")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(text, "排队中: 2") || !contains(text, "处理中: 1") {
		t.Errorf("队列计数不对(排队 2 / 处理中 1 = downloading):\n%s", text)
	}
	if !contains(text, "1. 🔄 <code>movie.mp4</code> (下载中)") {
		t.Errorf("活跃任务没渲染:\n%s", text)
	}
	if !contains(text, "🔑 网盘绑定: ❌ 未绑定") {
		t.Errorf("网盘状态行缺失:\n%s", text)
	}
	if !hasButton(buttons, "cancel_confirm_t1") {
		t.Errorf("缺取消按钮: %+v", buttons)
	}
	if !hasButton(buttons, "retry_confirm_t9") {
		t.Errorf("缺重试按钮: %+v", buttons)
	}
}

// TestStatusUserSubcommandListsHistory /status user 要给历史列表。
func TestStatusUserSubcommandListsHistory(t *testing.T) {
	repo := &statusRepo{
		fakeRepo: &fakeRepo{},
		counts:   map[string]int{},
		recent: []store.Task{
			testTask("t1", "42", contract.StatusCompleted),
			testTask("t2", "42", contract.StatusFailed),
		},
		tasks: map[string]*store.Task{},
	}
	a := newStatusApp(repo)

	text, _, err := a.statusView(context.Background(), "42", "user")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(text, "👤 您的任务历史") {
		t.Errorf("缺历史标题:\n%s", text)
	}
	if !contains(text, "(完成)") || !contains(text, "(失败)") {
		t.Errorf("历史状态没渲染:\n%s", text)
	}
	if contains(text, "🔑 网盘绑定") {
		t.Errorf("/status user 不该带网盘状态行:\n%s", text)
	}
}

// TestStatusNoTasksGivesGuidance 空队列要给引导,不能是光秃秃的 0。
func TestStatusNoTasksGivesGuidance(t *testing.T) {
	repo := &statusRepo{fakeRepo: &fakeRepo{}, counts: map[string]int{}, tasks: map[string]*store.Task{}}
	a := newStatusApp(repo)

	text, _, err := a.statusView(context.Background(), "42", "queue")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(text, statusNoActive) {
		t.Errorf("空队列缺引导文案:\n%s", text)
	}
}

// TestCancelRefusesOtherUsersTask —— 归属校验不能省。
//
// taskId 就在按钮的回调数据里,谁都能伪造。不校验就是任何人能取消
// 别人的转存任务。
func TestCancelRefusesOtherUsersTask(t *testing.T) {
	other := testTask("t1", "99", contract.StatusDownloading)
	repo := &statusRepo{
		fakeRepo: &fakeRepo{},
		tasks:    map[string]*store.Task{"t1": &other},
	}
	a := newStatusApp(repo)

	if got := a.cancelTask(context.Background(), "42", "t1"); got != statusTaskNotFound {
		t.Errorf("取消他人任务返回 %q,期望 %q", got, statusTaskNotFound)
	}
	if len(repo.trans) != 0 {
		t.Errorf("不该动状态机,却记了 %v", repo.trans)
	}
}

// TestRetryOwnTaskRequeues 自己的失败任务点重试要真的打回 queued。
func TestRetryOwnTaskRequeues(t *testing.T) {
	mine := testTask("t1", "42", contract.StatusFailed)
	repo := &statusRepo{
		fakeRepo: &fakeRepo{},
		tasks:    map[string]*store.Task{"t1": &mine},
	}
	a := newStatusApp(repo)

	if got := a.retryTask(context.Background(), "42", "t1"); got != statusCmdSent {
		t.Errorf("重试返回 %q,期望 %q", got, statusCmdSent)
	}
	if len(repo.trans) != 1 || repo.trans[0] != contract.EventRetry {
		t.Errorf("状态机事件 = %v,期望 [retry]", repo.trans)
	}
}

// TestStatusIconMatchesJS 图标与 JS _getTaskStatusIcon 逐字一致 ——
// 切换期两边同时在跑,同一状态显示不同图标会被当成 bug 报上来。
func TestStatusIconMatchesJS(t *testing.T) {
	cases := map[contract.TaskStatus]string{
		contract.StatusCompleted:   "✅",
		contract.StatusFailed:      "❌",
		contract.StatusCancelled:   "🚫",
		contract.StatusQueued:      "🕒",
		contract.StatusDownloading: "🔄",
		contract.StatusDownloaded:  "🔄",
		contract.StatusUploading:   "🔄",
	}
	for status, want := range cases {
		if got := statusIcon(status); got != want {
			t.Errorf("statusIcon(%s) = %q,期望 %q", status, got, want)
		}
	}
	if got := statusIcon("weird"); got != "•" {
		t.Errorf("未知状态图标 = %q,期望 •", got)
	}
}

func TestFormatUptime(t *testing.T) {
	if got := formatUptime(3*3600e9 + 5*60e9 + 9*1e9); got != "3h 5m 9s" {
		t.Errorf("formatUptime = %q,期望 3h 5m 9s", got)
	}
}

// groupTasksOf 往 fakeRepo 里塞一组任务 —— FindByGroupID 按它反查。
func groupTasksOf(repo *fakeRepo, gid int64, owner string, n int) {
	for i := 0; i < n; i++ {
		repo.batch = append(repo.batch, store.Task{
			ID:        fmt.Sprintf("g%d", i),
			UserID:    owner,
			Status:    contract.StatusQueued,
			GroupedID: sql.NullInt64{Int64: gid, Valid: true},
		})
	}
}

// TestCancelGroupCancelsEveryTask 点「取消整个相册」必须把组里每条
// 都打进状态机 —— 漏一条,那条文件照样传上网盘。
func TestCancelGroupCancelsEveryTask(t *testing.T) {
	repo := &statusRepo{fakeRepo: &fakeRepo{}}
	groupTasksOf(repo.fakeRepo, 999888, "42", 3)
	a := newStatusApp(repo)

	if got := a.cancelGroup(context.Background(), "42", "999888"); got != statusCmdSent {
		t.Fatalf("取消自己的组返回 %q", got)
	}
	if len(repo.trans) != 3 {
		t.Errorf("打了 %d 次状态机,期望 3 —— 有任务没被取消", len(repo.trans))
	}
	for _, ev := range repo.trans {
		if ev != contract.EventCancel {
			t.Errorf("事件 = %v,期望 cancel", ev)
		}
	}
}

// TestCancelGroupRefusesForeignGroup 组里混着别人的任务时整组拒。
// gid 在按钮回调数据里是明文,谁都能伪造一个别人的 gid。
func TestCancelGroupRefusesForeignGroup(t *testing.T) {
	repo := &statusRepo{fakeRepo: &fakeRepo{}}
	groupTasksOf(repo.fakeRepo, 999888, "99", 2) // 别人的组
	a := newStatusApp(repo)

	if got := a.cancelGroup(context.Background(), "42", "999888"); got != statusTaskNotFound {
		t.Errorf("取消他人的组返回 %q,期望 %q", got, statusTaskNotFound)
	}
	if len(repo.trans) != 0 {
		t.Errorf("不该动状态机,却记了 %v", repo.trans)
	}
}

// TestCancelGroupUnknownGid 编不出来的 gid 必须安静地拒绝。
func TestCancelGroupUnknownGid(t *testing.T) {
	repo := &statusRepo{fakeRepo: &fakeRepo{}}
	a := newStatusApp(repo)

	for _, gid := range []string{"0", "abc", ""} {
		if got := a.cancelGroup(context.Background(), "42", gid); got != statusTaskNotFound {
			t.Errorf("gid=%q 返回 %q,期望 %q", gid, got, statusTaskNotFound)
		}
	}
	if len(repo.trans) != 0 {
		t.Errorf("不该动状态机,却记了 %v", repo.trans)
	}
}

// TestStatusCallbackRouting 按钮数据与分发规则必须对上。
//
// 「取消整个相册」的两个回调曾在 handleStatusCallback 里实现好了、
// 单元测试全绿,但前缀没进 app.handleCallback 的白名单 —— 用户点下去
// 只得到「该功能暂未迁移」,整组取消等于没做。
func TestStatusCallbackRouting(t *testing.T) {
	for _, data := range []string{
		"cancel_confirm_t1", "cancel_execute_t1",
		"retry_confirm_t1", "retry_execute_t1",
		"cancel_group_confirm_999888", "cancel_group_execute_999888",
		"task_action_back", "status_general",
	} {
		if !isStatusCallback(data) {
			t.Errorf("%q 没被分发到 handleStatusCallback —— 按钮点了没反应", data)
		}
	}
	for _, data := range []string{"", "noop", "drive_bind_x", "cancel_group_", "cancel_"} {
		if isStatusCallback(data) {
			t.Errorf("%q 不该被当成状态回调", data)
		}
	}
}
