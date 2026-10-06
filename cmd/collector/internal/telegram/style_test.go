package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestStyleText(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		wantText string
		want     []string // entity 类型名
		wantOff  []int    // offset(UTF-16 code unit)
		wantLen  []int
	}{
		{
			name:     "纯文本原样透传",
			in:       "hello world",
			wantText: "hello world",
		},
		{
			name:     "去掉标签并留下 bold 实体",
			in:       "<b>粗</b>体",
			wantText: "粗体",
			want:     []string{"MessageEntityBold"},
			wantOff:  []int{0},
			wantLen:  []int{1},
		},
		{
			name:     "code 块",
			in:       "<code>ID: 42</code>",
			wantText: "ID: 42",
			want:     []string{"MessageEntityCode"},
			wantOff:  []int{0},
			wantLen:  []int{6},
		},
		{
			name:     "a href 生成 link 实体",
			in:       `see <a href="https://x.com">here</a>`,
			wantText: "see here",
			want:     []string{"MessageEntityTextURL"},
			wantOff:  []int{4},
			wantLen:  []int{4},
		},
		{
			name:     "已转义的尖括号还原成字面量",
			in:       "文件 &lt;a&gt;.jpg",
			wantText: "文件 <a>.jpg",
		},
		{
			// offset 按 UTF-16 code unit 计,不是字节也不是 rune。
			// 😀 要写成代理对,占 2 个 code unit,所以 offset 是 2。
			// 按 rune 算的实现会给 1;按 UTF-8 字节算会给 4。两条都错。
			name:     "emoji 之后的 offset 走 UTF-16",
			in:       "😀<code>x</code>",
			wantText: "😀x",
			want:     []string{"MessageEntityCode"},
			wantOff:  []int{2},
			wantLen:  []int{1},
		},
		{
			name:     "emoji 的 length 也走 UTF-16",
			in:       "<code>😀😀</code>",
			wantText: "😀😀",
			want:     []string{"MessageEntityCode"},
			wantOff:  []int{0},
			wantLen:  []int{4},
		},
		{
			// 汉字在 BMP 里,UTF-16 与 rune 同为 1 —— 确认上面那条不是碰巧。
			name:     "汉字偏移按 1 计",
			in:       "中文<code>x</code>",
			wantText: "中文x",
			want:     []string{"MessageEntityCode"},
			wantOff:  []int{2},
			wantLen:  []int{1},
		},
		{
			name:     "嵌套标签各自成实体",
			in:       "<b><i>x</i></b>",
			wantText: "x",
			want:     []string{"MessageEntityBold", "MessageEntityItalic"},
			wantOff:  []int{0, 0},
			wantLen:  []int{1, 1},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text, entities := styleText(tc.in)
			if text != tc.wantText {
				t.Fatalf("text = %q, want %q", text, tc.wantText)
			}
			if len(entities) != len(tc.want) {
				t.Fatalf("got %d entities %v, want %d", len(entities), describe(entities), len(tc.want))
			}
			for i, e := range entities {
				if got := typeName(e); got != tc.want[i] {
					t.Errorf("entity[%d] = %s, want %s", i, got, tc.want[i])
				}
				if e.GetOffset() != tc.wantOff[i] {
					t.Errorf("entity[%d] (%s).Offset = %d, want %d", i, tc.want[i], e.GetOffset(), tc.wantOff[i])
				}
				if e.GetLength() != tc.wantLen[i] {
					t.Errorf("entity[%d] (%s).Length = %d, want %d", i, tc.want[i], e.GetLength(), tc.wantLen[i])
				}
			}
		})
	}
}

// TestStyleText_DoesNotDropMessageOnBadHTML 保证解析失败时消息不丢。
// 没有这条,一个畸形标签就能让状态消息凭空消失 —— 比显示裸标签糟得多。
func TestStyleText_DoesNotDropMessageOnBadHTML(t *testing.T) {
	const in = `1 < 2 and 3 > 2 <b>x</b>`
	text, entities := styleText(in)
	if text == "" {
		t.Fatal("解析失败时文本被清空了 —— 消息会整个消失")
	}
	if len(entities) == 0 {
		t.Fatalf("期望至少解析出 <b>,entities=%v", describe(entities))
	}
	t.Logf("降级后的文本 = %q, entities = %v", text, describe(entities))
}

func typeName(e tg.MessageEntityClass) string {
	switch e.(type) {
	case *tg.MessageEntityBold:
		return "MessageEntityBold"
	case *tg.MessageEntityItalic:
		return "MessageEntityItalic"
	case *tg.MessageEntityCode:
		return "MessageEntityCode"
	case *tg.MessageEntityPre:
		return "MessageEntityPre"
	case *tg.MessageEntityTextURL:
		return "MessageEntityTextURL"
	case *tg.MessageEntityUnderline:
		return "MessageEntityUnderline"
	case *tg.MessageEntityStrike:
		return "MessageEntityStrike"
	default:
		return "unknown"
	}
}

func describe(entities []tg.MessageEntityClass) []string {
	out := make([]string, 0, len(entities))
	for _, e := range entities {
		out = append(out, typeName(e))
	}
	return out
}
