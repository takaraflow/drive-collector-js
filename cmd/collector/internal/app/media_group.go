package app

import (
	"context"
	"fmt"

	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
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

	// 每条消息都重新从 Telegram 取 —— 缓冲里只存 id,不存内容。
	// 存内容的话,消息被编辑或删除后就会拿着过期数据建任务。
	msgs, err := a.tg.FetchMessages(ctx, meta.ChatID, msgIDs)
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
			SourceType:  "telegram_media",
			FileName:    nullableString(m.FileName),
			SourceRef:   nullableString(fmt.Sprintf("%d/%d", m.ChatID, m.ID)),
			MsgID:       nullableInt(int64(m.ID)),
			SourceMsgID: nullableInt(m.SourceMsgID),
			// GroupedID 标识这批来自同一个媒体组,批量取消按它归组。
			// 之前 SourceMsgID 被写成 grouped_id,那是两个不同含义的
			// 字段混用了 —— 会让「按源消息反查任务」静默失效。
			GroupedID: nullableInt(m.GroupedID),
		})
	}
	if len(tasks) == 0 {
		return nil
	}

	if err := a.repo.CreateBatch(ctx, tasks); err != nil {
		return fmt.Errorf("批量建任务失败(gid=%s, %d 条): %w", gid, len(tasks), err)
	}
	a.log.Info("媒体组已建任务", "gid", gid, "条数", len(tasks))
	// 与单条路径一样:建完就得排队,否则这批图只会躺在 queued 里。
	for _, tsk := range tasks {
		a.enqueue(ctx, tsk.ID)
	}
	return nil
}
