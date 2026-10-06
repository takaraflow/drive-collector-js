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

	raw, known := extractMessages(messages)
	if !known {
		// 容器类型没认出来 —— 这是我们的解码/类型判断出了问题,不是用户
		// 撤回了消息。必须报错让调用方保留重试,而不是当成「取回 0 条」:
		// 后者会把整个相册静默丢弃,还留下一条误导性的「已撤回」日志。
		return nil, fmt.Errorf("取回消息返回了不认识的容器 %T(chat=%d, %d 条)",
			messages, chatID, len(ids))
	}

	out := make([]MessageInfo, 0, len(raw))
	for _, m := range raw {
		info, ok := messageInfoOf(m, chatID)
		if !ok {
			continue
		}
		out = append(out, info)
	}
	return out, nil
}

// messageInfoOf 把一条 gotd 消息抽成 MessageInfo。
//
// 抽成纯函数是因为这段逻辑有两处「必须如此」的判据,而它们只在这一层
// 生效(前面接 RPC、后面建任务,都会把错误藏起来):
//   - 私聊里 from_id 常常不发,拿不到就从 peer 兜底 —— 否则 user_id=0
//   - 照片没有 fileName,必须编一个 —— 否则整个相册塌成同一个文件
//
// 纯函数让这两条能直接被测,不必连真 Telegram。
func messageInfoOf(m tg.MessageClass, chatID int64) (MessageInfo, bool) {
	// MessageClass 只有 ID();其余字段都在 *tg.Message 上。
	msg, ok := m.(*tg.Message)
	if !ok {
		// MessageEmpty 等变体没有可提取的元数据。
		return MessageInfo{}, false
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
		// 私聊里 from_id 是【可选】字段 —— Telegram 常常不发,因为
		// 对话对方就是发送者。不从 peer 兜底的话 SenderID 是 0,
		// 而上传要靠它查用户网盘,结果是「用户 0 没有绑定网盘」。
		//
		// 【与 app/message.go 的兜底必须一致】两处是同一份逻辑的两个
		// 副本:改一处忘另一处,媒体组任务就会拿到 user_id=0,而门禁
		// 用的是 buffer 里的 userID(正确)所以放行 —— 任务建得出来、
		// 下载跑得动,只在上传那一刻才炸,且只炸相册。
		if info.SenderID == 0 && !msg.GetOut() {
			info.SenderID = peer.GetUserID()
		}
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
	return info, true
}

// extractMessages 从返回容器里取出消息列表。
//
// messages.getMessages 有两个带内容的容器:普通会话给
// MessagesMessages,频道/超级群给 MessagesChannelMessages —— bot 在群里
// 收相册时走的就是后者。只认前一个的话,群里的相册会被误判成
// 「用户撤回了」,组被静默丢弃。
//
// 第二个返回值是「容器认不认识」:认不出来必须让调用方【报错】,
// 而不是当成「取回了 0 条」—— 那会把基础设施问题说成用户撤回了消息,
// 排障方向直接跑偏。MessagesMessagesNotModified 确实没有内容,
// 那是合法的空,不算「不认识」。
func extractMessages(m tg.MessagesMessagesClass) ([]tg.MessageClass, bool) {
	switch v := m.(type) {
	case *tg.MessagesMessages:
		return v.Messages, true
	case *tg.MessagesChannelMessages:
		return v.Messages, true
	case *tg.MessagesMessagesNotModified:
		return nil, true
	default:
		return nil, false
	}
}

// FileNameOf 从媒体里取文件名。
//
// 导出是因为 app 包的消息提取也需要它 —— 【必须只有一份】。
// 曾经两个包各抄一份,而 app 那份对照片返回空,相册因此塌成同一个
// "unnamed" 文件;改一处忘另一处就会再次分叉。
func FileNameOf(m tg.MessageMediaClass) string { return fileNameOf(m) }

// fileNameOf 从媒体里取文件名。
//
// 照片是唯一必须自己编名的地方:它【没有 fileName 属性】,而空文件名
// 会让 sanitize() 变成 "unnamed" —— 于是【整个相册的每一张都塌成同一
// 个文件名】,串行 worker 逐个覆盖,用户发 10 张图网盘上只剩 1 张,
// 且全程不报错、不告警。
//
// 编名用【Telegram 侧的稳定标识】(dcId + id)而不是时间戳/UUID:随机名
// 每次都不同,同一张图重发就会反复新传一份,去重永远命中不了。
// 与 JS 侧 getMediaInfo 的编名规则逐字对齐。
//
// 无名文档(头像、视频等)仍返回空 —— 那是 app 层 app_test 明确锁定的
// 行为,不在本次修复范围内。
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
		return ""

	case *tg.MessageMediaPhoto:
		photo, ok := v.Photo.(*tg.Photo)
		if !ok {
			return ""
		}
		return fmt.Sprintf("transfer_%d_%d.jpg", photo.GetDCID(), photo.GetID())
	}
	return ""
}
