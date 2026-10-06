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

// ============================================================================
// 运行中任务账本
//
// 为什么需要它:rclone 层早就有杀进程组的能力(runner.go 里
// exec.CommandContext + Setpgid + cmd.Cancel),但那个进程句柄是局部变量,
// 出了 Runner 就没人能碰到。缺的从来不是「杀」,是「谁在跑」的账 ——
// 没有账本,取消按钮就只能改数据库状态,进程照跑到底,文件照样传上去,
// 而 EventComplete 会被状态机拒掉:用户看到「已取消」,文件其实在网盘里。
//
// 这就是全部内容:一个 map。不要 registry 接口、不要工厂、不要生命周期
// 管理器 —— 单进程串行 worker(taskWorkers=1)下,map 就是账本。
// ============================================================================

// runningTask 是账本里的一条:这个任务归谁、怎么掐死它。
type runningTask struct {
	userID string
	cancel context.CancelFunc
}

// registerRunning 登记一个正在跑的任务。
func (a *App) registerRunning(taskID, userID string, cancel context.CancelFunc) {
	a.runningMu.Lock()
	defer a.runningMu.Unlock()
	if a.running == nil {
		a.running = map[string]*runningTask{}
	}
	a.running[taskID] = &runningTask{userID: userID, cancel: cancel}
}

// unregisterRunning 注销。必须在 defer 里,和 cancel 一起 —— 只 cancel
// 不注销的话,map 会一直长,封禁时会把早就结束的任务也「杀」一遍。
func (a *App) unregisterRunning(taskID string) {
	a.runningMu.Lock()
	defer a.runningMu.Unlock()
	delete(a.running, taskID)
}

// cancelRunning 掐死指定任务。返回是否命中 —— 没命中只说明它不在跑
// (排队中,或已经结束),不是错误。
func (a *App) cancelRunning(taskID string) bool {
	a.runningMu.Lock()
	t := a.running[taskID]
	a.runningMu.Unlock()
	if t == nil {
		return false
	}
	t.cancel()
	return true
}

// CancelUserTasks 掐死某用户的全部在跑任务,返回掐了几条。
//
// 封禁时必须调:人被封了任务却还在替他上传,等于封禁没生效。
// 和 ClearUserSessions 并排放在封禁那一步 —— 都是「封了之后要收拾
// 干净的东西」。
//
// 【顺序不能反】先落终态,再 cancel。只 cancel 不改库的话,任务卡在
// uploading —— 而 recoverOnStart 每 StalledThreshold/2 扫一次,会把
// 这类非终态的「僵尸」重置成 queued 重新排队。结果是封禁白做:
// 被封的人过两分半钟照样把文件传上去,还白搭一次重下。
// 取消按钮那条路天生没这个问题(它先 MarkCancelled 再杀),封禁这条路
// 原本只有 cancel,所以必须自己把状态改掉。
func (a *App) CancelUserTasks(ctx context.Context, userID string) int {
	a.runningMu.Lock()
	var ids []string
	var cancels []context.CancelFunc
	for id, t := range a.running {
		if t.userID == userID {
			ids = append(ids, id)
			cancels = append(cancels, t.cancel)
		}
	}
	a.runningMu.Unlock()

	for i, id := range ids {
		if _, err := a.tasks.CancelTask(ctx, id); err != nil {
			// 落终态失败也要继续杀 —— 进程得停,状态下次再补。
			a.log.Error("封禁时标记任务失败", "taskId", id, "err", err)
		}
		cancels[i]()
	}
	return len(ids)
}

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

	// 每个任务一条独立的可取消 ctx,并登记进账本。
	//
	// ctx 一取消,底下的 rclone Runner 会通过 cmd.Cancel 杀掉整个进程组
	// —— 杀的能力本来就有,这里只是把句柄交出去,让取消按钮够得着。
	ctx, cancel := context.WithCancel(ctx)
	t := a.findTask(ctx, taskID)
	// t 可能是 nil(查库失败/任务不存在),下面 notify 对 nil 是安全的,
	// 但取 UserID 不是 —— 归属查不到就登记成空 userID,封禁时自然不会
	// 误杀别人的任务。
	userID := ""
	if t != nil {
		userID = t.UserID
	}
	a.registerRunning(taskID, userID, cancel)
	// cancel 必须在 defer 里:成功路径没人调它,context 会一直挂着,
	// 连带它引用的 timer/goroutine 一起泄漏。
	defer func() {
		a.unregisterRunning(taskID)
		cancel()
	}()

	// 每一步都把状态写回用户那条消息 —— 用户唯一能看到的东西就是它。
	// 建任务时已经发过「已捕获」,这里接着编辑成「正在下载」…
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
