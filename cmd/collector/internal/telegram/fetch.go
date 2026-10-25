package telegram

import (
	"context"
	"fmt"

	"github.com/gotd/td/tg"
)

// MessageInfo 是从 Telegram 重新取回的一条消息的摘要。
//
// 媒体组刷盘与链接解析转存时用它:内容现取 —— 消息被撤回或编辑后
// 就不会拿着过期数据建任务。
type MessageInfo struct {
	ID          int
	ChatID      int64
	SenderID    int64
	GroupedID   int64
	SourceMsgID int64
	HasMedia    bool
	FileName    string
	FileSize    int64
	AccessHash  int64
	Text        string
}

// FetchMessages 按 id 重新取回普通会话消息。
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

// FetchChannelMessages 从公开/私有频道取回指定范围的消息。
//
// username 优先使用 ContactsResolveUsername 解析;
// 若是私有超级群/频道(username 为空，channelID 非零)，则从 peers 缓存取 accessHash 并获取消息。
func (c *Client) FetchChannelMessages(ctx context.Context, username string, channelID int64, ids []int64) ([]MessageInfo, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	input := make([]tg.InputMessageClass, 0, len(ids))
	for _, id := range ids {
		input = append(input, &tg.InputMessageID{ID: int(id)})
	}

	if username != "" {
		res, err := c.tg.API().ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{Username: username})
		if err != nil {
			return nil, fmt.Errorf("telegram: 解析用户名 %s 失败: %w", username, err)
		}
		c.peers.store(res.Users)
		c.peers.storeChannels(res.Chats)

		switch p := res.Peer.(type) {
		case *tg.PeerChannel:
			var targetCh *tg.Channel
			for _, chat := range res.Chats {
				if ch, ok := chat.(*tg.Channel); ok && ch.ID == p.ChannelID {
					targetCh = ch
					break
				}
			}
			if targetCh == nil {
				return nil, fmt.Errorf("telegram: 未在解析结果中找到频道 %d", p.ChannelID)
			}
			hash, _ := targetCh.GetAccessHash()
			c.peers.storeChannel(targetCh.ID, hash)

			messages, err := c.tg.API().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
				Channel: &tg.InputChannel{ChannelID: targetCh.ID, AccessHash: hash},
				ID:      input,
			})
			if err != nil {
				return nil, fmt.Errorf("telegram: 取频道 %s 消息失败: %w", username, err)
			}
			raw, known := extractMessages(messages)
			if !known {
				return nil, fmt.Errorf("telegram: 频道消息返回了不认识的容器 %T", messages)
			}
			out := make([]MessageInfo, 0, len(raw))
			channelChatID := -1000000000000 - targetCh.ID
			for _, m := range raw {
				info, ok := messageInfoOf(m, channelChatID)
				if ok {
					info.AccessHash = hash
					out = append(out, info)
				}
			}
			return out, nil

		case *tg.PeerChat:
			messages, err := c.tg.API().MessagesGetMessages(ctx, input)
			if err != nil {
				return nil, fmt.Errorf("telegram: 取群聊 %s 消息失败: %w", username, err)
			}
			raw, known := extractMessages(messages)
			if !known {
				return nil, fmt.Errorf("telegram: 群聊消息返回了不认识的容器 %T", messages)
			}
			out := make([]MessageInfo, 0, len(raw))
			for _, m := range raw {
				info, ok := messageInfoOf(m, -p.ChatID)
				if ok {
					out = append(out, info)
				}
			}
			return out, nil

		default:
			return nil, fmt.Errorf("telegram: 目标 %s 不是频道或群聊", username)
		}
	}

	if channelID != 0 {
		hash, ok := c.peers.getChannel(channelID)
		if !ok && c.tg != nil {
			dialogs, err := c.tg.API().MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{Limit: 100})
			if err == nil && dialogs != nil {
				if mod, isMod := dialogs.AsModified(); isMod {
					c.peers.storeChannels(mod.GetChats())
					hash, ok = c.peers.getChannel(channelID)
				}
			}
		}
		if !ok {
			return nil, fmt.Errorf("telegram: 找不到频道 %d 的 accessHash，请确认机器人在该频道内", channelID)
		}
		messages, err := c.tg.API().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
			Channel: &tg.InputChannel{ChannelID: channelID, AccessHash: hash},
			ID:      input,
		})
		if err != nil {
			return nil, fmt.Errorf("telegram: 取私有频道 %d 消息失败: %w", channelID, err)
		}
		raw, known := extractMessages(messages)
		if !known {
			return nil, fmt.Errorf("telegram: 频道消息返回了不认识的容器 %T", messages)
		}
		out := make([]MessageInfo, 0, len(raw))
		channelChatID := -1000000000000 - channelID
		for _, m := range raw {
			info, ok := messageInfoOf(m, channelChatID)
			if ok {
				info.AccessHash = hash
				out = append(out, info)
			}
		}
		return out, nil
	}

	return nil, fmt.Errorf("telegram: 缺少频道标识")
}

// messageInfoOf 把一条 gotd 消息抽成 MessageInfo。
func messageInfoOf(m tg.MessageClass, chatID int64) (MessageInfo, bool) {
	msg, ok := m.(*tg.Message)
	if !ok {
		return MessageInfo{}, false
	}
	info := MessageInfo{
		ID:          msg.GetID(),
		ChatID:      chatID,
		SourceMsgID: int64(msg.GetID()),
		Text:        msg.GetMessage(),
	}
	if from, ok := msg.GetFromID(); ok {
		if user, isUser := from.(*tg.PeerUser); isUser {
			info.SenderID = user.GetUserID()
		}
	}
	if peer, ok := msg.GetPeerID().(*tg.PeerUser); ok {
		info.ChatID = peer.GetUserID()
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
		info.FileSize = fileSizeOf(media)
	}
	return info, true
}

func fileSizeOf(m tg.MessageMediaClass) int64 {
	switch v := m.(type) {
	case *tg.MessageMediaDocument:
		if doc, ok := v.Document.(*tg.Document); ok {
			return doc.GetSize()
		}
	case *tg.MessageMediaPhoto:
		if photo, ok := v.Photo.(*tg.Photo); ok {
			var bestSize int64
			for _, ps := range photo.GetSizes() {
				switch s := ps.(type) {
				case *tg.PhotoSize:
					if int64(s.Size) > bestSize {
						bestSize = int64(s.Size)
					}
				case *tg.PhotoSizeProgressive:
					for _, sz := range s.Sizes {
						if int64(sz) > bestSize {
							bestSize = int64(sz)
						}
					}
				}
			}
			return bestSize
		}
	case *tg.MessageMediaWebPage:
		if wp, ok := v.Webpage.(*tg.WebPage); ok {
			if docClass := wp.Document; docClass != nil {
				return fileSizeOf(&tg.MessageMediaDocument{Document: docClass})
			}
			if photoClass := wp.Photo; photoClass != nil {
				return fileSizeOf(&tg.MessageMediaPhoto{Photo: photoClass})
			}
		}
	}
	return 0
}

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
func FileNameOf(m tg.MessageMediaClass) string { return fileNameOf(m) }

// FileSizeOf 从媒体里取文件大小。
func FileSizeOf(m tg.MessageMediaClass) int64 { return fileSizeOf(m) }

func fileNameOf(m tg.MessageMediaClass) string {
	switch v := m.(type) {
	case *tg.MessageMediaDocument:
		doc, ok := v.Document.(*tg.Document)
		if !ok {
			return ""
		}
		for _, attr := range doc.Attributes {
			if fn, ok := attr.(*tg.DocumentAttributeFilename); ok && fn.FileName != "" {
				return fn.FileName
			}
		}
		ext := ".bin"
		for _, attr := range doc.Attributes {
			if _, ok := attr.(*tg.DocumentAttributeVideo); ok {
				ext = ".mp4"
				break
			}
			if _, ok := attr.(*tg.DocumentAttributeAudio); ok {
				ext = ".audio"
				break
			}
		}
		return fmt.Sprintf("transfer_%d_%d%s", doc.DCID, doc.ID, ext)

	case *tg.MessageMediaPhoto:
		photo, ok := v.Photo.(*tg.Photo)
		if !ok {
			return ""
		}
		return fmt.Sprintf("photo_%d_%d.jpg", photo.DCID, photo.ID)

	case *tg.MessageMediaWebPage:
		if wp, ok := v.Webpage.(*tg.WebPage); ok {
			if docClass := wp.Document; docClass != nil {
				return fileNameOf(&tg.MessageMediaDocument{Document: docClass})
			}
			if photoClass := wp.Photo; photoClass != nil {
				return fileNameOf(&tg.MessageMediaPhoto{Photo: photoClass})
			}
		}
		return ""

	default:
		return ""
	}
}
