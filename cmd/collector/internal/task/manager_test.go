package task

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// memRepo 是内存版的任务仓储,足够驱动 Manager 的状态推进。
// 乐观锁在这里天然成立(单进程互斥),但仍然按仓储层的语义返回结果。
type memRepo struct {
	mu    sync.Mutex
	tasks map[string]*store.Task
	// failTransition 让指定任务的转移被拒,模拟状态机拒绝。
	blockFrom map[string]contract.TaskStatus
	updates   int
}

func newMemRepo(tasks ...store.Task) *memRepo {
	r := &memRepo{tasks: map[string]*store.Task{}, blockFrom: map[string]contract.TaskStatus{}}
	for _, t := range tasks {
		c := t
		r.tasks[t.ID] = &c
	}
	return r
}

func (r *memRepo) FindById(_ context.Context, id string) (*store.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[id]
	if !ok {
		return nil, nil
	}
	c := *t
	return &c, nil
}

func (r *memRepo) FindByMsgId(_ context.Context, msgID int64) (*store.Task, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.tasks {
		if t.MsgID.Valid && t.MsgID.Int64 == msgID {
			c := *t
			return &c, nil
		}
	}
	return nil, nil
}

func (r *memRepo) Transition(
	_ context.Context, id string, ev contract.TaskEvent, errMsg *string,
) (store.TransitionResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	t, ok := r.tasks[id]
	if !ok {
		return store.TransitionResult{Blocked: true, Reason: "Task not found"}, nil
	}
	from := t.Status
	if b, forced := r.blockFrom[id]; forced && b == from {
		return store.TransitionResult{Blocked: true, Reason: "forced block", FromStatus: from}, nil
	}

	res, err := contract.ResolveTransition(from, ev)
	if err != nil {
		return store.TransitionResult{}, err
	}
	if !res.Allowed {
		return store.TransitionResult{Blocked: true, Reason: res.Reason, FromStatus: from}, nil
	}
	t.Status = res.ToStatus
	r.updates++
	return store.TransitionResult{
		Changed: true, Event: res.Event,
		FromStatus: from, ToStatus: res.ToStatus, Idempotent: res.Idempotent,
	}, nil
}

func (r *memRepo) status(id string) contract.TaskStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tasks[id].Status
}

func newManager(repo *memRepo, dl, up func(context.Context, store.Task) error) *Manager {
	m := NewManager(repo, quiet())
	m.Download, m.Upload = dl, up
	return m
}

var noopWork = func(context.Context, store.Task) error { return nil }

// TestBlockedActiveMustRetry503 这是本包最重要的一条契约。
//
// 任务处于活跃态时收到重复 webhook,必须回 503 让 QStash 重试。
// 返回 200 会让 QStash 认为投递成功,任务却没被处理 ——
// 用户表现为「文件一直没传上去,也没有任何提示」。
func TestBlockedActiveMustRetry503(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusDownloading})
	repo.blockFrom["t1"] = contract.StatusDownloading

	m := newManager(repo, noopWork, noopWork)
	res, err := m.HandleDownload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 503 {
		t.Errorf("活跃态被拒应回 503 让 QStash 重试,实际 %d (%s)", res.StatusCode, res.Message)
	}
	if res.Success {
		t.Error("503 不该标 success")
	}
}

// TestBlockedTerminalMustAck200 终态必须回 200 停止重试。
//
// 返回 503 会无限重试到烧完 QStash 配额 —— 记忆里踩过这个坑
// (「无法创建任务」= 1000/天配额爆)。
func TestBlockedTerminalMustAck200(t *testing.T) {
	for _, terminal := range []contract.TaskStatus{
		contract.StatusCompleted, contract.StatusFailed, contract.StatusCancelled,
	} {
		t.Run(string(terminal), func(t *testing.T) {
			repo := newMemRepo(store.Task{ID: "t1", Status: terminal})
			repo.blockFrom["t1"] = terminal

			m := newManager(repo, noopWork, noopWork)
			res, err := m.HandleDownload(context.Background(), "t1")
			if err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != 200 {
				t.Errorf("终态 %s 应回 200 停止重试,实际 %d", terminal, res.StatusCode)
			}
			if !res.Success {
				t.Error("200 应标 success")
			}
		})
	}
}

// TestCancelledIsAckedImmediately 用户取消的任务直接 ACK。
func TestCancelledIsAckedImmediately(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusCancelled})
	called := false
	m := newManager(repo,
		func(context.Context, store.Task) error { called = true; return nil },
		noopWork)

	res, err := m.HandleDownload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Errorf("应回 200,实际 %d", res.StatusCode)
	}
	if called {
		t.Error("已取消的任务不该触发下载")
	}
	if repo.status("t1") != contract.StatusCancelled {
		t.Error("已取消的任务状态不该被改动")
	}
}

// TestNotFoundIs404 任务不存在回 404,不重试。
func TestNotFoundIs404(t *testing.T) {
	repo := newMemRepo()
	m := newManager(repo, noopWork, noopWork)

	res, err := m.HandleDownload(context.Background(), "missing")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 404 {
		t.Errorf("应回 404,实际 %d", res.StatusCode)
	}
}

// TestHappyPathAdvancesToCompleted 正常路径:queued → downloading → completed。
// TestDownloadStopsAtDownloaded 下载阶段的终态是 downloaded,不是 completed。
//
// 这条曾经写错过:下载完直接发 complete → 任务跳到终态,紧接着的
// 上传就被状态机拒绝,而 resolveBlocked 对终态回 200 —— 调用方以为
// 上传成功了。生产实测:文件下载了但从没传到网盘,日志里还写着
// 「任务转存完成」。
func TestDownloadStopsAtDownloaded(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	m := newManager(repo, noopWork, noopWork)

	res, err := m.HandleDownload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("应回 200,实际 %d (%s)", res.StatusCode, res.Message)
	}
	if got := repo.status("t1"); got != contract.StatusDownloaded {
		t.Errorf("下载后状态 = %s,期望 downloaded", got)
	}
}

// TestTwoPhaseReachesCompleted 下载 → 上传两阶段走完才是 completed。
//
// 这是 processTask 的真实序列。任一步的事件写错都会让任务停在中间态,
// 或者提前判完成 —— 两种都不报错。
func TestTwoPhaseReachesCompleted(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	m := newManager(repo, noopWork, noopWork)

	if _, err := m.HandleDownload(context.Background(), "t1"); err != nil {
		t.Fatal(err)
	}
	if got := repo.status("t1"); got != contract.StatusDownloaded {
		t.Fatalf("下载后 = %s,期望 downloaded", got)
	}

	res, err := m.HandleUpload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("上传应回 200,实际 %d (%s)", res.StatusCode, res.Message)
	}
	if got := repo.status("t1"); got != contract.StatusCompleted {
		t.Errorf("上传后 = %s,期望 completed", got)
	}
}

// TestUploadAfterDownloadIsNotBlocked 守住上面那个 bug 的直接形态:
// 下载完之后调上传,不能被状态机拒绝。
//
// 拒绝本身不报错 —— resolveBlocked 对终态回 200,所以它伪装成成功。
// 这里同时断言状态真的推进了,而不只是「返回 200」。
func TestUploadAfterDownloadIsNotBlocked(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	uploaded := false
	m := newManager(repo, noopWork, func(context.Context, store.Task) error {
		uploaded = true
		return nil
	})

	if _, err := m.HandleDownload(context.Background(), "t1"); err != nil {
		t.Fatal(err)
	}
	res, err := m.HandleUpload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode == 200 && !uploaded {
		t.Fatal("上传返回 200 但执行器没被调用 —— 这正是静默丢文件的形态")
	}
	if !uploaded {
		t.Error("上传执行器没被调用")
	}
}

// TestFailureMarksFailedAndReturns5xx 处理失败必须落 failed。
//
// 状态停在 downloading 会让用户永远等不到结果 —— 而
// FindStalledTasks 只能捞回一部分,不是可靠兜底。
func TestFailureMarksFailedAndReturns5xx(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	m := newManager(repo,
		func(context.Context, store.Task) error { return errors.New("boom") },
		noopWork)

	res, err := m.HandleDownload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode < 500 {
		t.Errorf("处理失败应回 5xx 让 QStash 重试,实际 %d", res.StatusCode)
	}
	if got := repo.status("t1"); got != contract.StatusFailed {
		t.Errorf("失败后状态 = %s,期望 failed", got)
	}
}

// TestFailureRetryDoesNotLoopForever 失败后 QStash 重投,状态机挡住并回 200。
//
// 这条链路是「无限重试」风险的闭环:第一次回 5xx 触发重试,
// 第二次因为状态已是 failed 而回 200 终止。
func TestFailureRetryDoesNotLoopForever(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	m := newManager(repo,
		func(context.Context, store.Task) error { return errors.New("boom") },
		noopWork)

	first, _ := m.HandleDownload(context.Background(), "t1")
	if first.StatusCode < 500 {
		t.Fatalf("首次应回 5xx,实际 %d", first.StatusCode)
	}

	// 状态已是 failed,重投会被状态机拒绝 → 回 200 停止重试
	second, err := m.HandleDownload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if second.StatusCode != 200 {
		t.Errorf("重投应回 200 终止重试,实际 %d", second.StatusCode)
	}
}

// TestDownloadedTaskGoesToUpload 已下载的任务收到 download webhook 时补投上传。
//
// 场景:下载完成、上传未开始时进程被杀。这类任务收不到 download
// webhook,得靠这个分支捞回来。
func TestDownloadedTaskGoesToUpload(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusDownloaded})
	uploaded := false
	m := newManager(repo,
		func(context.Context, store.Task) error { return errors.New("不该下载") },
		func(context.Context, store.Task) error { uploaded = true; return nil })

	_, err := m.HandleDownload(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if !uploaded {
		t.Error("已下载的任务应直接走上传,不该再下载")
	}
	if got := repo.status("t1"); got != contract.StatusCompleted {
		t.Errorf("最终状态 = %s,期望 completed", got)
	}
}

// TestRetryRequeues 手动重试把任务打回 queued。
func TestRetryRequeues(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusFailed})
	m := newManager(repo, noopWork, noopWork)

	res, err := m.RetryTask(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Errorf("应回 200,实际 %d", res.StatusCode)
	}
	if got := repo.status("t1"); got != contract.StatusQueued {
		t.Errorf("重试后状态 = %s,期望 queued", got)
	}
}

// TestRetryOnCompletedIsAcked 已完成的任务不能再重试。
func TestRetryOnCompletedIsAcked(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusCompleted})
	m := newManager(repo, noopWork, noopWork)

	res, err := m.RetryTask(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Errorf("completed 不可重试,应回 200 终止,实际 %d", res.StatusCode)
	}
	if got := repo.status("t1"); got != contract.StatusCompleted {
		t.Errorf("状态不该被改动,实际 %s", got)
	}
}

// TestCancelTask 取消。
func TestCancelTask(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	m := newManager(repo, noopWork, noopWork)

	if _, err := m.CancelTask(context.Background(), "t1"); err != nil {
		t.Fatal(err)
	}
	if got := repo.status("t1"); got != contract.StatusCancelled {
		t.Errorf("状态 = %s,期望 cancelled", got)
	}
}

// TestMissingExecutorIsAnError 没注入执行器要报错 —— 静默成功会
// 让任务假装完成但文件没传。
func TestMissingExecutorIsAnError(t *testing.T) {
	repo := newMemRepo(store.Task{ID: "t1", Status: contract.StatusQueued})
	m := NewManager(repo, quiet()) // 故意不注入 Download

	if _, err := m.HandleDownload(context.Background(), "t1"); err == nil {
		t.Error("未注入执行器应报错")
	} else if !strings.Contains(err.Error(), "执行器") {
		t.Errorf("错误信息应说明是执行器缺失,得到 %q", err.Error())
	}
}
