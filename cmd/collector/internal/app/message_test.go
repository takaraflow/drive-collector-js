package app

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// TestTruncateKeepsCharactersWhole 中文不能被劈成半个。
//
// 日志里会打印用户消息和文件名,而中间文字符占 3 字节。按字节截断
// 会把一个汉字切成半个 —— 日志里就是 `\xe9\xb2` 这样的乱码,
// 排查时完全读不出用户发的是什么。
func TestTruncateKeepsCharactersWhole(t *testing.T) {
	// 10 个汉字 = 30 字节。按字节截到 8 会劈开第 3 个字。
	s := "一二三四五六七八九十"

	got := truncate(s, 4)
	if !utf8.ValidString(got) {
		t.Fatalf("截断后不是合法 UTF-8:%q", got)
	}
	if got != "一二三四…" {
		t.Errorf("truncate = %q,期望 %q", got, "一二三四…")
	}
}

// TestTruncateLeavesShortStringsAlone 短串原样返回,不加省略号。
//
// 加了省略号会让人以为消息被截过 —— 而它其实完整。
func TestTruncateLeavesShortStringsAlone(t *testing.T) {
	if got := truncate("abc", 10); got != "abc" {
		t.Errorf("truncate = %q,期望原样 %q", got, "abc")
	}
	// 边界:长度正好等于上限
	if got := truncate("abcd", 4); got != "abcd" {
		t.Errorf("长度等于上限时不该截:%q", got)
	}
}

// TestTruncateHandlesDegenerateInputs 空串和非法上限不 panic。
//
// 这个函数在日志路径上,它 panic 会让整个 update 处理中断 ——
// 而日志本身是排障用的,不该成为故障源。
func TestTruncateHandlesDegenerateInputs(t *testing.T) {
	if got := truncate("", 5); got != "" {
		t.Errorf("空串应返回空串,得到 %q", got)
	}
	if got := truncate("abc", 0); got != "" {
		t.Errorf("n=0 应返回空串,得到 %q", got)
	}
	if got := truncate("abc", -1); got != "" {
		t.Errorf("n<0 应返回空串,得到 %q", got)
	}
}

// TestTruncateDoesNotSplitRuneAcrossManyLengths 遍历所有长度都不能切出乱码。
//
// 单点断言容易漏掉「某一个特定长度才出问题」的情况 ——
// 截断的 bug 恰好是这类边界 bug。
func TestTruncateDoesNotSplitRuneAcrossManyLengths(t *testing.T) {
	s := "文件名带中文和 emoji 🎬 混排"
	for n := 1; n <= len(s)+5; n++ {
		got := truncate(s, n)
		if !utf8.ValidString(got) {
			t.Errorf("n=%d 切出了非法 UTF-8:%q", n, got)
		}
		// 截断后的可见内容(去掉省略号)必须是原串的前缀
		body := strings.TrimSuffix(got, "…")
		if !strings.HasPrefix(s, body) {
			t.Errorf("n=%d 的结果不是原串前缀:%q", n, got)
		}
	}
}
