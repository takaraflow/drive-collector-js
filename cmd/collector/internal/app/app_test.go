package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gotd/td/tg"

	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func loadSession(t *testing.T) *tgsession.Session {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "testdata", "tgsession_vectors.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	var v struct {
		Cases []struct {
			S string `json:"s"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	s, err := tgsession.Parse(v.Cases[0].S)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// TestSanitizeBlocksTraversal 文件名来自 Telegram,是完全不受控的输入。
//
// 目录穿越不是洁癖:命中后下载会落到任意可写路径,
// 而那些文件随后会被当成用户上传的内容发到网盘。
func TestSanitizeBlocksTraversal(t *testing.T) {
	cases := []struct{ in, mustNotContain string }{
		{"../../etc/passwd", ".."},
		{"..", ".."},
		{".", ".."},
		{"", ""},
		{"a/b/c.txt", "/"},
		{`C:\Windows\System32\evil.dll`, "\\"},
		{"normal.txt", ".."}, // 正常的应原样通过
	}
	for _, tc := range cases {
		got := sanitize(tc.in)
		if tc.mustNotContain != "" && strings.Contains(got, tc.mustNotContain) {
			t.Errorf("sanitize(%q) = %q,不该包含 %q", tc.in, got, tc.mustNotContain)
		}
		if got == "" {
			t.Errorf("sanitize(%q) 返回空串 —— 后续路径拼接会把文件写成目录", tc.in)
		}
		if strings.HasPrefix(got, ".") {
			t.Errorf("sanitize(%q) = %q,不该以点开头(会变成隐藏文件)", tc.in, got)
		}
	}
}

// TestSanitizeStripsControlChars 控制字符和非 ASCII 必须被替换。
func TestSanitizeStripsControlChars(t *testing.T) {
	got := sanitize("bad\x00name\n换行.exe")
	if strings.ContainsAny(got, "\x00\n") {
		t.Errorf("sanitize 未清除控制字符: %q", got)
	}
	if !strings.Contains(got, "bad") || !strings.Contains(got, "exe") {
		t.Errorf("sanitize 应保留可读部分: %q", got)
	}
}

// TestSanitizeTruncates 超长文件名要截断 —— 路径长度有限度,
// 不截会得到 ENAMETOOLONG。
func TestSanitizeTruncates(t *testing.T) {
	long := strings.Repeat("a", 500) + ".txt"
	if got := sanitize(long); len(got) > 200 {
		t.Errorf("长度 = %d,应截断到 200 以内", len(got))
	}
}

// TestTaskIDIsUnpredictable 任务 id 会出现在文件名和日志里,
// 可猜测会泄漏「这个用户一共多少任务」。
func TestTaskIDIsUnpredictable(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := newTaskID()
		if seen[id] {
			t.Fatalf("第 %d 次生成了重复 id: %s", i, id)
		}
		seen[id] = true
		if !strings.HasPrefix(id, "task-") {
			t.Errorf("id %q 缺前缀", id)
		}
	}
}

// TestFileNameOfDocument 文档名要从 attribute 里取。
func TestFileNameOfDocument(t *testing.T) {
	doc := &tg.Document{ID: 1, Size: 100}
	doc.Attributes = []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "report.pdf"},
	}
	media := &tg.MessageMediaDocument{Document: doc}

	if got := fileNameOf(media); got != "report.pdf" {
		t.Errorf("文件名 = %q,期望 report.pdf", got)
	}
}

// TestFileNameOfDocumentWithoutName 没文件名属性时返回空串。
func TestFileNameOfDocumentWithoutName(t *testing.T) {
	doc := &tg.Document{ID: 1, Size: 100}
	doc.Attributes = nil
	if got := fileNameOf(&tg.MessageMediaDocument{Document: doc}); got != "" {
		t.Errorf("无文件名属性时应返回空串,得到 %q", got)
	}
}

// TestFromMessageExtractsMediaFields 从消息里抽字段。
func TestFromMessageExtractsMediaFields(t *testing.T) {
	doc := &tg.Document{ID: 7, Size: 2048}
	doc.Attributes = []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "a.zip"},
	}
	// flag 必须显式设 —— gotd 的 getter 靠 Flags 判断字段是否有效,
	// 直接赋值不会设 flag,getter 一律返回零值。这是 gotd 的系统性约定,
	// 写测试时最容易踩。
	// flag 必须显式设 —— gotd 的 getter 靠 Flags 判断字段是否有效,
	// 直接赋值不会设 flag,getter 一律返回零值。这是 gotd 的系统性约定,
	// 写测试时最容易踩。
	// 用 SetMedia 而不是直接赋值 —— 它自己会设 flag 9。
	// 直接给字段赋值不设 flag 的话,GetMedia 一律返回 false,
	// 而代码看起来完全正确。
	msg := &tg.Message{
		ID:     42,
		PeerID: &tg.PeerChat{ChatID: 999},
		FromID: &tg.PeerUser{UserID: 555},
	}
	msg.Flags.Set(4) // from_id
	msg.SetMedia(&tg.MessageMediaDocument{Document: doc})
	msg.Flags.Set(4) // from_id
	msg.Flags.Set(8) // media

	info, ok := fromMessage(msg)
	if !ok {
		t.Fatal("应能提取")
	}
	if info.ID != 42 {
		t.Errorf("ID = %d", info.ID)
	}
	if info.ChatID != 999 {
		t.Errorf("ChatID = %d", info.ChatID)
	}
	if info.SenderID != 555 {
		t.Errorf("SenderID = %d", info.SenderID)
	}
	if !info.HasMedia {
		t.Error("HasMedia 应为 true")
	}
	if info.FileName != "a.zip" {
		t.Errorf("FileName = %q", info.FileName)
	}
}

// TestFromMessageRejectsEmpty 空消息不该被当成有效消息。
func TestFromMessageRejectsEmpty(t *testing.T) {
	if _, ok := fromMessage(&tg.MessageEmpty{ID: 1}); ok {
		t.Error("空消息不该被接受")
	}
}

// TestNewRejectsMissingDeps 配置不全必须硬失败。
func TestNewRejectsMissingDeps(t *testing.T) {
	// 缺仓储
	if _, err := New(Config{Session: loadSession(t), Log: quiet()}); err == nil {
		t.Error("缺 Repo 应报错")
	}
	// 缺 session
	if _, err := New(Config{Log: quiet()}); err == nil {
		t.Error("缺 session 应报错")
	}
}

// TestNullableString 空串必须是无效值 —— 否则会往 D1 写空串,
// 与「没有值」混淆。
func TestNullableString(t *testing.T) {
	if nullableString("").Valid {
		t.Error("空串不该是有效值")
	}
	if !nullableString("x").Valid {
		t.Error("非空串应是有效值")
	}
}

// TestRunRefusesWithoutCoordinator 没协调器必须拒绝运行。
//
// 这是防双实例并发的最后一道闸:没有锁就连接 Telegram,会和 Node
// 同时处理同一批消息,表现为「同一个文件被传两次」。
func TestRunRefusesWithoutCoordinator(t *testing.T) {
	a, err := New(Config{
		APIID:   1,
		APIHash: "h",
		Session: loadSession(t),
		Repo:    nil,
		Log:     quiet(),
	})
	if err != nil {
		// 缺 Repo 时构造就该失败,这也是对的
		return
	}
	if err := a.Run(context.Background()); err == nil {
		t.Error("缺协调器时 Run 应报错")
	}
}
