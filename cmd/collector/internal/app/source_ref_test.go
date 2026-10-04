package app

import (
	"encoding/json"
	"testing"
)

// TestBuildSourceRefMatchesNodeFormat source_ref 的字节形态是跨语言契约。
//
// JS 侧 resolveStoredTelegramMediaSource 会 JSON.parse 它,再取 messageId
// 去拉原始消息。格式不对时它不报错,而是静默回退到 source_msg_id ——
// 于是「回滚到 Node」这条路会在若干任务上悄悄失灵。
//
// 对照 src/domain/task-source.js 的 buildTelegramMediaSourceRef:
// chatId 是【字符串】(JS 侧显式 String() 过,大整数会丢精度),
// messageId 是数字。
func TestBuildSourceRefMatchesNodeFormat(t *testing.T) {
	got := BuildSourceRef(7428626313, 4534)

	// 期望的字节级形态(字段名、类型、顺序)
	want := `{"chatId":"7428626313","messageId":4534}`
	if got != want {
		t.Errorf("BuildSourceRef = %s,期望 %s", got, want)
	}

	// 再确认一遍类型:chatId 必须是字符串,不能是数字
	var raw map[string]any
	if err := json.Unmarshal([]byte(got), &raw); err != nil {
		t.Fatalf("不是合法 JSON: %v", err)
	}
	if _, isStr := raw["chatId"].(string); !isStr {
		t.Errorf("chatId 类型 = %T,必须是字符串(JS 侧按字符串读)", raw["chatId"])
	}
	if _, isNum := raw["messageId"].(float64); !isNum {
		t.Errorf("messageId 类型 = %T,必须是数字", raw["messageId"])
	}
}

// TestSourceRefRoundTrip 写出去的要能读回来。
func TestSourceRefRoundTrip(t *testing.T) {
	for _, c := range []struct{ chatID, msgID int64 }{
		{7428626313, 4534},
		{0, 1},
		{-1001234567890, 987}, // 频道 id 是负数
		{95908897, 1},
	} {
		raw := BuildSourceRef(c.chatID, c.msgID)
		chatID, msgID, err := ParseSourceRef(raw)
		if err != nil {
			t.Fatalf("解析 %s 失败: %v", raw, err)
		}
		if chatID != c.chatID || msgID != c.msgID {
			t.Errorf("往返后 = (%d,%d),期望 (%d,%d)", chatID, msgID, c.chatID, c.msgID)
		}
	}
}

// TestParseSourceRefToleratesLegacySlash 兼容 Go 早期写的 "chatId/msgId"。
//
// 线上残留过一条这种格式的记录(已修)。容错是过渡措施,不是长期契约 ——
// 留着它的代价是「格式写错了」会被悄悄吞掉,所以 ParseSourceRef 的
// 注释里标了删除条件。
func TestParseSourceRefToleratesLegacySlash(t *testing.T) {
	chatID, msgID, err := ParseSourceRef("7428626313/4542")
	if err != nil {
		t.Fatalf("旧格式应能解析: %v", err)
	}
	if chatID != 7428626313 || msgID != 4542 {
		t.Errorf("解析旧格式 = (%d,%d)", chatID, msgID)
	}
}

// TestParseSourceRefRejectsGarbage 解析不了必须报错,不能返回 (0,0)。
//
// 返回 (0,0) 的话下载会去拉 chat 0 的 0 号消息 —— 报一个和「数据坏了」
// 毫无关系的错。
func TestParseSourceRefRejectsGarbage(t *testing.T) {
	for _, raw := range []string{"", "   ", "not-a-path", "{}", `{"chatId":"1"}`, "abc/def"} {
		if _, _, err := ParseSourceRef(raw); err == nil {
			t.Errorf("%q 应报错", raw)
		}
	}
}
