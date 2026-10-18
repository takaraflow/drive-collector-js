package app

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// telegramSourceRef 是 telegram 媒体任务的 source_ref 结构。
//
// 字段名和类型必须与 JS 侧 buildTelegramMediaSourceRef 一致:
// chatId 是【字符串】(JS 侧显式 String() 过 —— 大整数在 JS 里会丢精度,
// 所以那边一路走字符串),messageId 是数字。
// AccessHash 为可选字段，供跨节点重试及频道下载时直接定位 InputChannel。
type telegramSourceRef struct {
	ChatID     string `json:"chatId"`
	MessageID  int64  `json:"messageId"`
	AccessHash int64  `json:"accessHash,omitempty"`
}

// BuildSourceRef 构造存进 tasks.source_ref 的值。
func BuildSourceRef(chatID, messageID int64) string {
	return BuildSourceRefWithHash(chatID, messageID, 0)
}

// BuildSourceRefWithHash 构造存进 tasks.source_ref 的值，并附带频道的 accessHash。
func BuildSourceRefWithHash(chatID, messageID, accessHash int64) string {
	b, err := json.Marshal(telegramSourceRef{
		ChatID:     strconv.FormatInt(chatID, 10),
		MessageID:  messageID,
		AccessHash: accessHash,
	})
	if err != nil {
		if accessHash != 0 {
			return fmt.Sprintf(`{"chatId":%q,"messageId":%d,"accessHash":%d}`, strconv.FormatInt(chatID, 10), messageID, accessHash)
		}
		return fmt.Sprintf(`{"chatId":%q,"messageId":%d}`, strconv.FormatInt(chatID, 10), messageID)
	}
	return string(b)
}

// ParseSourceRef 从 tasks.source_ref 解出 (chatID, messageID)。
func ParseSourceRef(raw string) (chatID, messageID int64, err error) {
	c, m, _, err := ParseSourceRefFull(raw)
	return c, m, err
}

// ParseSourceRefFull 从 tasks.source_ref 解出 (chatID, messageID, accessHash)。
func ParseSourceRefFull(raw string) (chatID, messageID, accessHash int64, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, 0, 0, fmt.Errorf("source_ref 为空")
	}

	var ref telegramSourceRef
	if json.Unmarshal([]byte(raw), &ref) == nil && ref.MessageID != 0 {
		cid, cerr := strconv.ParseInt(ref.ChatID, 10, 64)
		if cerr != nil {
			return 0, 0, 0, fmt.Errorf("source_ref 的 chatId 不是合法数字: %w", cerr)
		}
		return cid, ref.MessageID, ref.AccessHash, nil
	}

	// 过渡形态。ponytail: 确认无残留后删掉这一段。
	if _, serr := fmt.Sscanf(raw, "%d/%d", &chatID, &messageID); serr == nil {
		return chatID, messageID, 0, nil
	}
	return 0, 0, 0, fmt.Errorf("source_ref 无法解析: %q", raw)
}
