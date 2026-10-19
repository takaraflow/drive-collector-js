package app

import (
	"context"
	"fmt"
	"sort"

	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

const noticeLinkParseFailed = "❌ <b>无法解析这个链接</b>\n\n请确认链接可访问，或重新发送文件本身。"

// handleLinkMessage 检查并处理文本消息中包含的 Telegram 消息链接。
// 若匹配到 Telegram 链接则返回 true 表示该更新已由链接处理器消费。
func (a *App) handleLinkMessage(ctx context.Context, msg messageInfo) bool {
	parsed, ok := tgclient.ParseLink(msg.Text)
	if !ok {
		return false
	}

	a.log.Info("识别到 Telegram 消息链接",
		"text", msg.Text,
		"username", parsed.ChannelUsername,
		"channelId", parsed.ChannelID,
		"msgId", parsed.MessageID,
		"isPrivate", parsed.IsPrivate)

	// 未绑定网盘先提示绑定
	if !a.requireDrive(ctx, msg.ChatID, msg.SenderID) {
		return true
	}

	if a.fetcher == nil {
		a.log.Warn("未装配 fetcher，无法探测链接消息")
		a.sendLinkParseFailed(ctx, msg.ChatID)
		return true
	}

	// 探测范围: targetID 前后 9 条 (对齐 JS LinkParser [id-9 .. id+9])
	start := parsed.MessageID - 9
	if start < 1 {
		start = 1
	}
	end := parsed.MessageID + 9
	ids := make([]int64, 0, end-start+1)
	for i := start; i <= end; i++ {
		ids = append(ids, i)
	}

	fetched, err := a.fetcher.FetchChannelMessages(ctx, parsed.ChannelUsername, parsed.ChannelID, ids)
	if err != nil {
		a.log.Warn("链接消息探测失败", "text", msg.Text, "err", err)
		a.sendLinkParseFailed(ctx, msg.ChatID)
		return true
	}

	// 找到目标消息
	var target *tgclient.MessageInfo
	for i := range fetched {
		if int64(fetched[i].ID) == parsed.MessageID {
			target = &fetched[i]
			break
		}
	}

	if target == nil || !target.HasMedia {
		a.log.Warn("目标链接消息不存在或不包含媒体", "targetMsgId", parsed.MessageID)
		a.sendLinkParseFailed(ctx, msg.ChatID)
		return true
	}

	// 提取媒体：如果是媒体组，提取同组媒体；否则单条
	var toProcess []tgclient.MessageInfo
	if target.GroupedID != 0 {
		for _, m := range fetched {
			if m.GroupedID == target.GroupedID && m.HasMedia {
				toProcess = append(toProcess, m)
			}
		}
	} else {
		toProcess = []tgclient.MessageInfo{*target}
	}

	if len(toProcess) == 0 {
		a.sendLinkParseFailed(ctx, msg.ChatID)
		return true
	}

	// 先按消息 ID 升序排列，保证队列顺序与首选媒体一致
	sort.Slice(toProcess, func(i, j int) bool {
		return toProcess[i].ID < toProcess[j].ID
	})

	// 媒体数量上限 10
	if len(toProcess) > 10 {
		if a.notifier != nil {
			_ = a.notifier.SendMessage(ctx, msg.ChatID, "⚠️ 仅处理前 10 个媒体。")
		}
		toProcess = toProcess[:10]
	}

	if len(toProcess) == 1 {
		if err := a.createLinkTask(ctx, msg, toProcess[0]); err != nil {
			a.log.Error("创建链接转存任务失败", "err", err)
		}
		return true
	}

	if err := a.createLinkAlbumTasks(ctx, msg, toProcess); err != nil {
		a.log.Error("创建链接相册转存任务失败", "err", err)
	}
	return true
}

func (a *App) sendLinkParseFailed(ctx context.Context, chatID int64) {
	if a.notifier != nil {
		if err := a.notifier.SendMessage(ctx, chatID, noticeLinkParseFailed); err != nil {
			a.log.Warn("发送链接解析失败通知失败", "chatId", chatID, "err", err)
		}
	}
}

func (a *App) createLinkTask(ctx context.Context, orig messageInfo, m tgclient.MessageInfo) error {
	taskID := newTaskID()
	noticeID := a.postNotice(ctx, orig.ChatID, taskID)

	t := store.Task{
		ID:          taskID,
		UserID:      fmt.Sprintf("%d", orig.SenderID),
		ChatID:      nullableString(fmt.Sprintf("%d", orig.ChatID)),
		SourceType:  "telegram_media",
		FileName:    nullableString(m.FileName),
		FileSize:    m.FileSize,
		SourceRef:   nullableString(BuildSourceRefWithHash(m.ChatID, int64(m.ID), m.AccessHash)),
		MsgID:       nullableInt(int64(noticeID)),
		SourceMsgID: nullableInt(int64(m.ID)),
		GroupedID:   nullableInt(m.GroupedID),
	}

	if err := a.repo.Create(ctx, t); err != nil {
		if noticeID != 0 && a.notices != nil {
			_ = a.notices.EditMessage(ctx, orig.ChatID, noticeID, "❌ <b>创建任务失败</b>，请稍后重发。")
		}
		return fmt.Errorf("入库失败: %w", err)
	}
	a.enqueue(ctx, taskID)
	return nil
}

func (a *App) createLinkAlbumTasks(ctx context.Context, orig messageInfo, msgs []tgclient.MessageInfo) error {
	tasks := make([]store.Task, 0, len(msgs))

	for _, m := range msgs {
		tasks = append(tasks, store.Task{
			ID:          newTaskID(),
			UserID:      fmt.Sprintf("%d", orig.SenderID),
			ChatID:      nullableString(fmt.Sprintf("%d", orig.ChatID)),
			SourceType:  "telegram_media",
			FileName:    nullableString(m.FileName),
			FileSize:    m.FileSize,
			SourceRef:   nullableString(BuildSourceRefWithHash(m.ChatID, int64(m.ID), m.AccessHash)),
			SourceMsgID: nullableInt(int64(m.ID)),
			GroupedID:   nullableInt(m.GroupedID),
		})
	}

	if err := a.repo.CreateBatch(ctx, tasks); err != nil {
		if a.notifier != nil {
			_ = a.notifier.SendMessage(ctx, orig.ChatID, "❌ 媒体组创建任务失败，请重试。")
		}
		return fmt.Errorf("媒体组批量入库失败: %w", err)
	}

	var noticeID int
	if a.notices != nil {
		folder := "/"
		if a.drives != nil {
			if d, err := a.drives.DefaultDrive(ctx, tasks[0].UserID); err == nil && d != nil {
				folder = d.RemotePath(a.cfg.RemoteBase)
			}
		}
		initialText, initialButtons := renderGroupMonitor(tasks, nil, "", folder, nil)
		id, err := a.notices.SendWithButtonsAndID(ctx, orig.ChatID, initialText, initialButtons)
		if err != nil {
			a.log.Warn("发送媒体组看板消息失败", "groupedId", tasks[0].GroupedID.Int64, "err", err)
		} else {
			noticeID = id
		}
	}

	// 媒体组任务共享一条看板卡片，回填看板消息 msg_id
	if noticeID != 0 {
		for i := range tasks {
			if err := a.repo.UpdateMsgID(ctx, tasks[i].ID, noticeID); err != nil {
				a.log.Error("回填链接媒体组任务看板消息 id 失败", "taskId", tasks[i].ID, "err", err)
			}
		}
	}

	for _, t := range tasks {
		a.enqueue(ctx, t.ID)
	}
	return nil
}
