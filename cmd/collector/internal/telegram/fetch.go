package telegram

import (
	"context"
	"fmt"

	"github.com/gotd/td/tg"
)

// MessageInfo 是从 Telegram 重新取回的一条消息的摘要。
//
// 媒体组刷盘时用它:缓冲里只存 id,内容要现取 —— 存内容的话,
// 消息被撤回或编辑后就会拿着过期数据建任务。
type MessageInfo struct {
	ID          int
	ChatID      int64
	SenderID    int64
	GroupedID   int64
	SourceMsgID int64
	HasMedia    bool
	FileName    string
}

// FetchMessages 按 id 重新取回消息。
//
// 【必须回源而不是用缓存】Telegram 允许撤回和编辑消息;缓冲里存的
// 只是 id,内容一律现取。
func (c *Client) FetchMessages(ctx context.Context, chatID int64, ids []int64) ([]MessageInfo, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	input := make([]tg.InputMessageClass, 0, len(ids))
	for _, id := range ids {
		input = append(input, &tg.InputMessageID{ID: int(id)})
	}

	messages, err := c.tg.API().MessagesGetMessages(ctx, input)
	if err != nil {
		return nil, fmt.Errorf("取回消息失败(chat=%d, %d 条): %w", chatID, len(ids), err)
	}

	raw := extractMessages(messages)
	out := make([]MessageInfo, 0, len(raw))
	for _, m := range raw {
		// MessageClass 只有 ID();其余字段都在 *tg.Message 上。
		msg, ok := m.(*tg.Message)
		if !ok {
			// MessageEmpty 等变体没有可提取的元数据。
			continue
		}
		info := MessageInfo{
			ID:     msg.GetID(),
			ChatID: chatID,
			// SourceMsgID 是这条消息自己的 id —— 与 GroupedID 是两回事。
			// 之前把两者混用,让「按源消息反查任务」静默失效。
			SourceMsgID: int64(msg.GetID()),
		}
		if from, ok := msg.GetFromID(); ok {
			if user, isUser := from.(*tg.PeerUser); isUser {
				info.SenderID = user.GetUserID()
			}
		}
		if peer, ok := msg.GetPeerID().(*tg.PeerUser); ok {
			info.ChatID = peer.GetUserID()
		}
		if peer, ok := msg.GetPeerID().(*tg.PeerChat); ok {
			info.ChatID = peer.GetChatID()
		}
		if gid, ok := msg.GetGroupedID(); ok {
			info.GroupedID = gid
		}
		if media, has := msg.GetMedia(); has && media != nil {
			info.HasMedia = true
			info.FileName = fileNameOf(media)
		}
		out = append(out, info)
	}
	return out, nil
}

// extractMessages 从返回容器里取出消息列表。
//
// MessagesMessagesClass 有四个实现变体(普通 / 切片 / 频道 / 未修改),
// 但只有 MessagesMessages 带完整消息列表;其余要么是分片要么没有内容。
// 这里只认有内容的那个 —— 认错的表现是「取回了 0 条」,而调用方
// 会以为消息被撤回了。
func extractMessages(m tg.MessagesMessagesClass) []tg.MessageClass {
	if v, ok := m.(*tg.MessagesMessages); ok {
		return v.Messages
	}
	return nil
}

// fileNameOf 从媒体里取文件名。
func fileNameOf(m tg.MessageMediaClass) string {
	switch v := m.(type) {
	case *tg.MessageMediaDocument:
		doc, ok := v.Document.(*tg.Document)
		if !ok {
			return ""
		}
		for _, attr := range doc.Attributes {
			if name, ok := attr.(*tg.DocumentAttributeFilename); ok {
				return name.FileName
			}
		}
	}
	return ""
}
