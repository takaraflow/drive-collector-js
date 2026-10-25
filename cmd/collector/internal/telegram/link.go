package telegram

import (
	"regexp"
	"strconv"
)

// ParsedLink 是从文本提取的 Telegram 消息链接。
type ParsedLink struct {
	// ChannelUsername 是公开频道或超级群的用户名(不含 @)。
	ChannelUsername string
	// ChannelID 是私有频道或超级群的数字 ID (对应 t.me/c/<id>/<msgId>)。
	ChannelID int64
	// MessageID 是目标消息在频道中的 ID。
	MessageID int64
	// IsPrivate 为 true 时表示链接形如 t.me/c/...，需要通过加入的群组上下文访问。
	IsPrivate bool
}

// tgLinkRe 匹配 Telegram 消息链接。
//
// 捕获组:
//
//  1. 私有频道/超级群 ID: t.me/c/(\d+)
//  2. 公开频道/超级群用户名: t.me/([a-zA-Z0-9_]+)
//  3. 消息 ID: (\d+) (支持带话题/Forum 分区号: /topic/msgId)
var tgLinkRe = regexp.MustCompile(`(?i)(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?(?:c\/(\d+)|([a-zA-Z0-9_]+))\/(?:(?:\d+)\/)?(\d+)`)

// ParseLink 从文本中解析第一处 Telegram 消息链接。
//
// 支持形式:
//   - https://t.me/username/1234
//   - http://t.me/username/1234
//   - t.me/username/1234
//   - https://telegram.me/username/1234
//   - https://t.me/s/username/1234
//   - https://t.me/username/10/1234 (Forum 话题)
//   - https://t.me/c/1234567890/1234
//   - https://t.me/c/1234567890/10/1234 (私有群 Forum 话题)
//   - 携带 ?single 等查询参数或结尾斜杠的形式
func ParseLink(text string) (ParsedLink, bool) {
	sub := tgLinkRe.FindStringSubmatch(text)
	if len(sub) < 4 {
		return ParsedLink{}, false
	}

	msgID, err := strconv.ParseInt(sub[3], 10, 64)
	if err != nil || msgID <= 0 {
		return ParsedLink{}, false
	}

	if sub[1] != "" {
		cid, err := strconv.ParseInt(sub[1], 10, 64)
		if err != nil || cid <= 0 {
			return ParsedLink{}, false
		}
		return ParsedLink{
			ChannelID: cid,
			MessageID: msgID,
			IsPrivate: true,
		}, true
	}

	if sub[2] != "" {
		return ParsedLink{
			ChannelUsername: sub[2],
			MessageID:       msgID,
			IsPrivate:       false,
		}, true
	}

	return ParsedLink{}, false
}

// ParseChannelID 把 chatID (如 -1001234567890) 规范化为 MTProto channelID (如 1234567890)。
// 若为频道返回规范化后的 ID 和 true，否则返回 0 和 false。
func ParseChannelID(chatID int64) (int64, bool) {
	if chatID < 0 {
		chID := -chatID
		if chID >= 1000000000000 {
			return chID - 1000000000000, true
		}
	}
	return 0, false
}
