// Package task 是任务编排的核心逻辑。
//
// 相比 JS 侧 src/processor/TaskManager.js,这里砍掉了单实例下的纯开销:
//
//   - leader 租约校验:单实例没有第二个实例,恒为 leader
//   - webhook task lock(Redis 分布式锁):单实例下并发只有一处入口
//   - claim 租约心跳:没有第二个实例会偷任务
//
// **但保留了两条**,它们是正确性而非性能:
//
//  1. 状态机转移 —— 判断「该不该处理」,跨语言向量已锁死。
//  2. _resolveBlockedWebhookResult 的 503/200 分流 ——
//     被状态机拒绝时,活跃态回 503 让 QStash 重试,终态回 200 停止重试。
//     搞错的后果是双向灾难:该重试的不重试(任务卡死),
//     不该重试的无限重试(烧完 QStash 配额 —— 记忆里踩过)。
package task

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

// Result 是 webhook 处理的结果。
//
// 字段与 JS 侧 handleDownloadWebhook 的返回值对齐 —— 边缘节点原样
// 转发给 QStash,状态码决定 QStash 认不认这次投递。
type Result struct {
	Success  bool   `json:"success"`
	StatusCode int  `json:"statusCode"`
	Message  string `json:"message"`
}

func ok(msg string) Result     { return Result{Success: true, StatusCode: 200, Message: msg} }
func notFound() Result         { return Result{Success: false, StatusCode: 404, Message: "Task not found"} }
func retryLater(kind string) Result {
	return Result{Success: false, StatusCode: 503, Message: kind + " task is active; retry later"}
}

// Repo 是 Manager 需要的仓储能力。
//
// 刻意定义接口而不是直接用 *store.Repository:Manager 只关心
// 「查任务 + 推状态」,不关心它存在 D1 还是内存。测试能注入内存实现,
// 也让这个包不与 D1 耦合。
type Repo interface {
	FindById(ctx context.Context, taskID string) (*store.Task, error)
	Transition(ctx context.Context, taskID string, ev contract.TaskEvent, errMsg *string) (store.TransitionResult, error)
}

// Manager 编排任务处理。
type Manager struct {
	repo Repo
	log  *slog.Logger

	// Download 执行实际下载。由 Telegram 层注入 —— 本包不依赖
	// Telegram,只负责「该不该处理」的判断和状态推进。
	Download func(ctx context.Context, task store.Task) error
	// Upload 执行实际上传。
	Upload func(ctx context.Context, task store.Task) error
}

func NewManager(repo Repo, log *slog.Logger) *Manager {
	return &Manager{repo: repo, log: log}
}

// HandleDownload 处理下载 webhook。
func (m *Manager) HandleDownload(ctx context.Context, taskID string) (Result, error) {
	dbTask, err := m.repo.FindById(ctx, taskID)
	if err != nil {
		return Result{}, err
	}
	if dbTask == nil {
		m.log.Error("任务不在数据库中", "taskId", taskID)
		return notFound(), nil
	}

	// 用户已取消:直接 ACK。不能回 5xx —— 那会让 QStash 一直重投
	// 一个用户已经明确放弃的任务。
	if dbTask.Status == contract.StatusCancelled {
		m.log.Info("任务已取消,跳过下载 webhook", "taskId", taskID)
		return ok("Task cancelled"), nil
	}

	// 已下载完的走上传队列修复(进程重启后遗留的半成品)。
	if dbTask.Status == contract.StatusDownloaded {
		return m.enqueueDownloadedForUpload(ctx, dbTask)
	}

	claim, err := m.repo.Transition(ctx, taskID, contract.EventStartDownload, nil)
	if err != nil {
		return Result{}, err
	}
	if claim.Blocked {
		m.log.Info("下载 webhook 被状态机拒绝",
			"taskId", taskID, "reason", claim.Reason, "from", claim.FromStatus)
		return resolveBlocked("download", claim.FromStatus), nil
	}

	return m.run(ctx, *dbTask, "download", m.Download)
}

// HandleUpload 处理上传 webhook。
func (m *Manager) HandleUpload(ctx context.Context, taskID string) (Result, error) {
	dbTask, err := m.repo.FindById(ctx, taskID)
	if err != nil {
		return Result{}, err
	}
	if dbTask == nil {
		m.log.Error("任务不在数据库中", "taskId", taskID)
		return notFound(), nil
	}

	if dbTask.Status == contract.StatusCancelled {
		return ok("Task cancelled"), nil
	}

	claim, err := m.repo.Transition(ctx, taskID, contract.EventStartUpload, nil)
	if err != nil {
		return Result{}, err
	}
	if claim.Blocked {
		m.log.Info("上传 webhook 被状态机拒绝",
			"taskId", taskID, "reason", claim.Reason, "from", claim.FromStatus)
		return resolveBlocked("upload", claim.FromStatus), nil
	}

	return m.run(ctx, *dbTask, "upload", m.Upload)
}

// run 执行实际处理并推进到终态。
//
// 失败一律记为 failed 并保留原因 —— 状态停在 downloading/uploading
// 会让用户永远等不到结果,而 FindStalledTasks 只能捞回一部分。
func (m *Manager) run(
	ctx context.Context,
	task store.Task,
	kind string,
	work func(context.Context, store.Task) error,
) (Result, error) {
	if work == nil {
		return Result{}, fmt.Errorf("task: %s 执行器未注入", kind)
	}

	if err := work(ctx, task); err != nil {
		m.log.Error("任务处理失败", "kind", kind, "taskId", task.ID, "err", err)
		msg := err.Error()
		if _, terr := m.repo.Transition(ctx, task.ID, contract.EventFail, &msg); terr != nil {
			m.log.Error("标记失败时出错", "taskId", task.ID, "err", terr)
		}
		// 处理失败回 5xx:QStash 会重试。状态已经是 failed,
		// 重试时会被状态机挡住并回 200 —— 不会无限重试。
		return Result{Success: false, StatusCode: 500, Message: kind + " failed"}, nil
	}

	if _, err := m.repo.Transition(ctx, task.ID, contract.EventComplete, nil); err != nil {
		m.log.Error("标记完成时出错", "taskId", task.ID, "err", err)
		return Result{Success: false, StatusCode: 500, Message: "finalize failed"}, nil
	}
	return ok(kind + " completed"), nil
}

// enqueueDownloadedForUpload 处理「已下载但没上传」的遗留任务。
//
// 典型场景:下载完成、上传还没开始时进程被杀。这类任务不会收到
// download webhook,只能靠 upload webhook 或启动扫描捞回来。
func (m *Manager) enqueueDownloadedForUpload(ctx context.Context, task *store.Task) (Result, error) {
	m.log.Info("任务已下载,补投上传队列", "taskId", task.ID)
	return m.run(ctx, *task, "upload", m.Upload)
}

// resolveBlocked 复刻 JS 侧 _resolveBlockedWebhookResult。
//
// 这是整套逻辑里最容易搞错、后果又最严重的一处:
//   - 活跃态(queued/downloading/downloaded/uploading)→ 503
//     让 QStash 稍后重试。返回 200 会让任务卡在中间态等不到结果。
//   - 终态(completed/failed/cancelled)→ 200
//     停止重试。返回 503 会无限重试到烧完 QStash 配额。
func resolveBlocked(kind string, from contract.TaskStatus) Result {
	switch {
	case contract.IsActiveStatus(from):
		return retryLater(kind)
	case contract.IsTerminalStatus(from):
		return ok("Task already terminal")
	default:
		return ok("Ignored by " + kind + " state machine")
	}
}

// RetryTask 手动重试 —— 用户点「重试」按钮时走这里。
func (m *Manager) RetryTask(ctx context.Context, taskID string) (Result, error) {
	claim, err := m.repo.Transition(ctx, taskID, contract.EventRetry, nil)
	if err != nil {
		return Result{}, err
	}
	if claim.Blocked {
		return resolveBlocked("retry", claim.FromStatus), nil
	}
	// retry 只是把任务打回 queued,真正的处理由随后的 webhook 触发。
	return ok("Task requeued"), nil
}

// CancelTask 用户取消。
func (m *Manager) CancelTask(ctx context.Context, taskID string) (Result, error) {
	res, err := m.repo.Transition(ctx, taskID, contract.EventCancel, nil)
	if err != nil {
		return Result{}, err
	}
	if res.Blocked {
		return resolveBlocked("cancel", res.FromStatus), nil
	}
	return ok("Task cancelled"), nil
}