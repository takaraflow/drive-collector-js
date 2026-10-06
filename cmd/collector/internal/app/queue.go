package app

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

const (
	// pendingQueueSize 是「建完等着处理」的缓冲深度。
	//
	// 取 512:正常水位是个位数,留足余量吸收突发(用户一口气发几十个
	// 文件)。真的打满了说明处理速度跟不上,那时阻塞入队反而是对的 ——
	// 丢掉任务才是灾难。
	pendingQueueSize = 512

	// taskWorkers 是并发处理数。
	//
	// 刻意不放开:每个任务要 spawn 一个 rclone 进程,并发高了会把容器
	// 的内存和带宽打满(记忆里«直传 failed closed»那次就是部署过频 +
	// 资源争抢)。串行慢一点,但可控。
	//
	// ponytail: 串行处理,吞吐不够时按用户分片并行。
	taskWorkers = 1
)

// enqueue 把新建的任务排进处理队列。
//
// 队列满时阻塞而不是丢弃 —— 见 pendingQueueSize 的说明。
func (a *App) enqueue(ctx context.Context, taskID string) {
	select {
	case a.pending <- taskID:
	case <-ctx.Done():
		// 进程正在关闭。任务留在 queued,下次启动 recoverOnStart 会捞回来。
		a.log.Info("关闭中,任务留待下次恢复", "taskId", taskID)
	}
}

// runTaskQueue 启动消费循环,阻塞到 ctx 结束。
//
// 这就是 worker 模式里「建完任务之后该干什么」的答案:直接执行,而不是
// 发一条永远不会被回调的队列消息(Go 没有 QStash 发布器)。
func (a *App) runTaskQueue(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < taskWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case taskID := <-a.pending:
					a.processTask(ctx, taskID)
				}
			}
		}()
	}
	wg.Wait()
}

// processTask 把一个任务从 queued 推到终态:下载 → 上传。
//
// 状态推进全部交给 task.Manager —— 它带着乐观锁(WHERE id=? AND status=?)
// 和 503/200 分流。自己改状态会绕过那层保护,并发下会把同一个任务推进两次。
func (a *App) processTask(ctx context.Context, taskID string) {
	started := time.Now()

	// 每一步都把状态写回用户那条消息 —— 用户唯一能看到的东西就是它。
	// 建任务时已经发过「已捕获」,这里接着编辑成「正在下载」…
	t := a.findTask(ctx, taskID)
	busy := [][]tgclient.Button{{
		{Text: noticeCancelBtn, Data: "cancel_confirm_" + taskID},
	}}

	// 下载。被状态机挡住(用户已取消 / 已在处理中)不是错误,直接停手。
	a.notify(ctx, t, noticeDownloading, busy)
	res, err := a.tasks.HandleDownload(ctx, taskID)
	if err != nil {
		a.log.Error("下载处理异常", "taskId", taskID, "err", err)
		return
	}
	if !res.Success {
		a.log.Info("下载未完成,不再进入上传", "taskId", taskID, "msg", res.Message)
		a.notifyOutcome(ctx, taskID, false)
		return
	}

	a.notify(ctx, a.findTask(ctx, taskID), noticeUploading, busy)
	res, err = a.tasks.HandleUpload(ctx, taskID)
	if err != nil {
		a.log.Error("上传处理异常", "taskId", taskID, "err", err)
		return
	}
	if !res.Success {
		a.log.Warn("上传未完成", "taskId", taskID, "msg", res.Message)
		a.notifyOutcome(ctx, taskID, true)
		return
	}

	a.log.Info("任务转存完成",
		"taskId", taskID, "耗时", time.Since(started).Round(time.Millisecond).String())
	a.notifyOutcome(ctx, taskID, true)
}

// findTask 取任务;查不到返回 nil 而不是让整条链路崩掉 ——
// notify 对 nil 是安全的(没源消息就没什么可编辑的)。
func (a *App) findTask(ctx context.Context, taskID string) *store.Task {
	t, err := a.repo.FindById(ctx, taskID)
	if err != nil {
		a.log.Warn("查任务失败", "taskId", taskID, "err", err)
		return nil
	}
	return t
}

// notifyOutcome 任务走到终态时把最终结果写回状态消息。
//
// 读库而不是看 HandleXxx 的返回值:被状态机挡下(用户已取消、已在
// 处理中)也回 Success=false,但那不是「失败」—— 那种情况给用户弹一条
// 转存失败是撒谎。uploadPhase 决定用哪句文案(下载失败没有重试按钮
// 以外的说法,上传失败才值得给「重试」)。
func (a *App) notifyOutcome(ctx context.Context, taskID string, uploadPhase bool) {
	t := a.findTask(ctx, taskID)
	if t == nil {
		return
	}
	switch t.Status {
	case contract.StatusCompleted:
		a.notify(ctx, t, a.noticeSuccessText(ctx, *t), nil)

	case contract.StatusCancelled:
		a.notify(ctx, t, noticeCancelled, nil)

	case contract.StatusFailed:
		reason := escapeHTMLText(noticeReason(errors.New(t.ErrorMsg.String)))
		text := fmt.Sprintf(noticeFail, reason)
		buttons := [][]tgclient.Button{}
		if uploadPhase {
			text = fmt.Sprintf(noticeUploadFail, reason)
			buttons = append(buttons, []tgclient.Button{
				{Text: noticeRetryBtn, Data: "retry_confirm_" + taskID},
			})
		}
		a.notify(ctx, t, text, buttons)
	}
	// 其余状态(queued/downloading/…):任务还在别的环节,别抢它的消息。
}
