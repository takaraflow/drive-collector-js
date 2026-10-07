package app

import (
	"context"
	"fmt"

	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// flushMediaGroup 把一个媒体组刷成任务。
//
// 【必须真的建任务】不接这个回调的话,组会被清掉但任务不建 ——
// 用户的 10 张图凭空消失,而且没有任何错误。这是「静默丢数据」里
// 最糟的一种:用户只看到「我明明发了文件」。
//
// chatID 从组数据里取(Add 时已存入),不靠任何全局状态回溯 ——
// 媒体组刷盘发生在 1 秒缓冲窗口之后,那时 update 上下文已经不在。
func (a *App) flushMediaGroup(ctx context.Context, gid string, meta task.GroupMeta, msgIDs []int64) error {
	if len(msgIDs) == 0 {
		return nil
	}

	// 没绑盘就不建任务 —— 与单条路径同一道门。
	//
	// 必须在【刷盘时】再查一次:组是 1 秒缓冲后才刷的,这期间用户
	// 可能刚解绑。返回 nil 让组被清掉 —— 这批文件本来就不该处理,
	// 留着只会在下一轮再撞一次同一道门。
	if !a.requireDrive(ctx, meta.ChatID, meta.UserID) {
		return nil
	}

	// 每条消息都重新从 Telegram 取 —— 缓冲里只存 id,不存内容。
	// 存内容的话,消息被编辑或删除后就会拿着过期数据建任务。
	msgs, err := a.fetcher.FetchMessages(ctx, meta.ChatID, msgIDs)
	if err != nil {
		// 返回错误让组留在 Redis 里等重试 —— 返回 nil 会清掉组,
		// 那批文件就永久丢失。
		return fmt.Errorf("取回媒体组消息失败(gid=%s, %d 条): %w", gid, len(msgIDs), err)
	}
	if len(msgs) == 0 {
		// 全被撤回了 —— 不是错误,是用户主动撤的。
		a.log.Info("媒体组消息已被撤回,不建任务", "gid", gid, "条数", len(msgIDs))
		return nil
	}

	tasks := make([]store.Task, 0, len(msgs))
	for _, m := range msgs {
		if !m.HasMedia {
			continue // 媒体组里混入的文本消息,跳过
		}
		tasks = append(tasks, store.Task{
			ID:          newTaskID(),
			UserID:      fmt.Sprintf("%d", m.SenderID),
			ChatID:      nullableString(fmt.Sprintf("%d", m.ChatID)),
			SourceType:  "telegram_media",
			FileName:    nullableString(m.FileName),
			SourceRef:   nullableString(BuildSourceRef(m.ChatID, int64(m.ID))),
			SourceMsgID: nullableInt(int64(m.ID)),
			// GroupedID 标识这批来自同一个媒体组,批量取消按它归组。
			// 之前 SourceMsgID 被写成 grouped_id,那是两个不同含义的
			// 字段混用了 —— 会让「按源消息反查任务」静默失效。
			GroupedID: nullableInt(m.GroupedID),
		})
	}
	if len(tasks) == 0 {
		return nil
	}

	// 【必须先落库,再发状态消息】
	//
	// 顺序反了的话,建任务失败时用户已经收到 N 条「已捕获」,而每条的
	// 取消按钮都指向一个【不存在的任务】—— 点下去只会得到 "task not
	// found",消息也永远停在「已捕获」不动。相册批量插入本来就可能整批
	// 失败(D1 参数上限),所以这不是假想场景。
	if err := a.repo.CreateBatch(ctx, tasks); err != nil {
		return fmt.Errorf("批量建任务失败(gid=%s, %d 条): %w", gid, len(tasks), err)
	}

	// 每条任务各发一条状态消息(而不是 JS 侧那种共享一条看板):
	// 看板要额外一套 group monitor 状态机才画得出来,而这里串行
	// 消费队列,一人一条最省事 —— 10 张图就是 10 条各自的结果。
	// msg_id 是 bot 自己那条状态消息,后续每个阶段都编辑它 ——
	// 消息发出去才知道 id,所以要回填。
	for i := range tasks {
		if err := a.repo.UpdateMsgID(ctx, tasks[i].ID,
			a.postNotice(ctx, meta.ChatID, tasks[i].ID)); err != nil {
			// 回填失败不该让这批任务作废 —— 任务已经在库里,后续阶段
			// 会退回发新消息。只记日志。
			a.log.Error("回填任务状态消息 id 失败", "taskId", tasks[i].ID, "err", err)
		}
	}

	a.log.Info("媒体组已建任务", "gid", gid, "条数", len(tasks))

	// 组级汇总消息:带「取消整个相册」按钮 —— grouped_id 现在落库了,
	// 按 gid 一次就能反查并取消整批。发不出去只记日志:任务本身是好的。
	if a.notices != nil {
		if _, err := a.notices.SendWithButtonsAndID(ctx, meta.ChatID,
			fmt.Sprintf("📸 <b>已捕获相册</b>\n%d 个文件正在排队处理...", len(tasks)),
			[][]tgclient.Button{{
				{Text: groupCancelBtn, Data: "cancel_group_confirm_" + gid},
			}}); err != nil {
			a.log.Error("发相册汇总消息失败", "gid", gid, "err", err)
		}
	}

	// 与单条路径一样:建完就得排队,否则这批图只会躺在 queued 里。
	for _, tsk := range tasks {
		a.enqueue(ctx, tsk.ID)
	}
	return nil
}
