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
type telegramSourceRef struct {
	ChatID    string `json:"chatId"`
	MessageID int64  `json:"messageId"`
}

// BuildSourceRef 构造存进 tasks.source_ref 的值。
//
// 格式是 JSON,不是自定义的 "chatId/msgId" —— 这是跨语言契约:
// JS 侧 resolveStoredTelegramMediaSource 会 JSON.parse 它,再取
// messageId 去拉原始消息。格式不对时它不报错,而是静默回退到
// source_msg_id,于是「回滚到 Node」这条路会在若干任务上悄悄失灵。
func BuildSourceRef(chatID, messageID int64) string {
	b, err := json.Marshal(telegramSourceRef{
		ChatID:    strconv.FormatInt(chatID, 10),
		MessageID: messageID,
	})
	if err != nil {
		// Marshal 一个纯 string/int 结构不会失败 —— 真失败了说明
		// 结构体被改坏了,给个显眼的坏值比静默返回空串好。
		return fmt.Sprintf(`{"chatId":%q,"messageId":%d}`, strconv.FormatInt(chatID, 10), messageID)
	}
	return string(b)
}

// ParseSourceRef 从 tasks.source_ref 解出 (chatID, messageID)。
//
// 兼容两种形态:
//   - JSON(规范形态,与 JS 侧一致)
//   - "chatId/msgId"(Go 早期版本写的,线上残留过一条)
//
// 兼容后者是过渡措施 —— 等确认没有残留记录后应当删掉,留着会让
// 「格式写错了」这类问题被悄悄吞掉。
func ParseSourceRef(raw string) (chatID, messageID int64, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, 0, fmt.Errorf("source_ref 为空")
	}

	var ref telegramSourceRef
	if json.Unmarshal([]byte(raw), &ref) == nil && ref.MessageID != 0 {
		cid, cerr := strconv.ParseInt(ref.ChatID, 10, 64)
		if cerr != nil {
			return 0, 0, fmt.Errorf("source_ref 的 chatId 不是合法数字: %w", cerr)
		}
		return cid, ref.MessageID, nil
	}

	// 过渡形态。ponytail: 确认无残留后删掉这一段。
	if _, serr := fmt.Sscanf(raw, "%d/%d", &chatID, &messageID); serr == nil {
		return chatID, messageID, nil
	}
	return 0, 0, fmt.Errorf("source_ref 无法解析: %q", raw)
}
