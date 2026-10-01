package tgsession

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vectors struct {
	Cases []struct {
		Name string `json:"name"`
		S    string `json:"s"`
		Key  string `json:"key"`
	} `json:"cases"`
	Malformed []struct {
		Name string `json:"name"`
		S    string `json:"s"`
	} `json:"malformed"`
}

func load(t *testing.T) vectors {
	t.Helper()
	p := filepath.Join("..", "..", "..", "..", "testdata", "tgsession_vectors.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读取向量失败: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	return v
}

// TestParseMatchesGramJS 是影子模式的地基。
//
// Go 必须能读懂 Node 写入的 session —— 否则只能重新登录,而重新登录
// 会触发 AUTH_KEY_DUPLICATED 把线上实例踢下线(记忆里的 PR#445/447)。
func TestParseMatchesGramJS(t *testing.T) {
	v := load(t)
	if len(v.Cases) == 0 {
		t.Fatal("向量为空,需重跑 npm run test:vectors:tgsession")
	}

	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Parse(c.S)
			if err != nil {
				t.Fatalf("Parse 失败: %v", err)
			}
			wantKey, err := base64.StdEncoding.DecodeString(c.Key)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.AuthKey, wantKey) {
				t.Errorf("authKey 不匹配(长度 got=%d want=%d)", len(got.AuthKey), len(wantKey))
			}
			if got.DCID <= 0 {
				t.Errorf("dcId = %d,期望正数", got.DCID)
			}
			if got.ServerAddr == "" {
				t.Error("serverAddr 为空")
			}
			if got.Port <= 0 || got.Port > 65535 {
				t.Errorf("port = %d 不合法", got.Port)
			}
			if got.Addr() == "" {
				t.Error("Addr() 为空")
			}
		})
	}
}

// TestRejectsMalformed 畸形输入必须明确报错。
// 静默解出垃圾 authKey 会导致连不上 Telegram 且错误信息完全误导。
func TestRejectsMalformed(t *testing.T) {
	v := load(t)
	for _, m := range v.Malformed {
		t.Run(m.Name, func(t *testing.T) {
			if _, err := Parse(m.S); err == nil {
				t.Error("畸形 session 应被拒绝")
			}
		})
	}
}

// TestRejectsTruncatedAuthKey 尾部被截断必须拒,不能接受短 key。
func TestRejectsTruncatedAuthKey(t *testing.T) {
	// 构造一个头部合法但 authKey 只有 100 字节的串
	raw := make([]byte, 0, 200)
	raw = append(raw, 2)
	raw = append(raw, 0x00, 0x0e) // addrLen = 14
	raw = append(raw, []byte("149.154.175.116")...)
	raw = append(raw, 0x00, 0x50) // port 80
	raw = append(raw, make([]byte, 100)...)
	s := "1" + base64.StdEncoding.EncodeToString(raw)

	if _, err := Parse(s); err == nil {
		t.Error("authKey 被截断的 session 应被拒绝")
	}
}

// TestRejectsTelethonFormat gramjs 在总长 352 时按 Telethon 格式解析
// (无 addrLen 字段)。我们不解它,但必须能识别并明说,而不是解出垃圾。
func TestRejectsTelethonFormat(t *testing.T) {
	raw := make([]byte, telethonSessionByteLen)
	raw[0] = 2
	raw[1], raw[2], raw[3], raw[4] = 149, 154, 175, 116
	s := "1" + base64.StdEncoding.EncodeToString(raw)

	_, err := Parse(s)
	if err == nil {
		t.Fatal("Telethon 格式应被明确拒绝")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("telethon")) {
		t.Errorf("错误信息应说明是 telethon 格式,实际: %v", err)
	}
}

// TestNeverReturnsShortKey 任何情况下都不能返回短于 256 字节的 key。
func TestNeverReturnsShortKey(t *testing.T) {
	for _, bad := range []string{"", "1", "1MA==", "not-a-session"} {
		s, err := Parse(bad)
		if err != nil {
			continue // 报错是对的
		}
		if len(s.AuthKey) != 256 {
			t.Errorf("Parse(%q) 返回了 %d 字节的 key,期望报错", bad, len(s.AuthKey))
		}
	}
}
