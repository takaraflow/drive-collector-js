package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type queueVectorFile struct {
	Keys []struct {
		Topic      string  `json:"topic"`
		Type       string  `json:"type"`
		TaskID     string  `json:"taskId"`
		Attempt    *string `json:"attempt"`
		Key        string  `json:"key"`
		Normalized string  `json:"normalized"`
	} `json:"keys"`
	Payloads []struct {
		Name          string `json:"name"`
		TaskID        string `json:"taskId"`
		Type          string `json:"type"`
		GroupID       string `json:"groupId"`
		TriggerSource string `json:"triggerSource"`
		InstanceID    string `json:"instanceId"`
		HasTimestamp  bool   `json:"hasTimestamp"`
	} `json:"payloads"`
	// rawBodies 让 Go 侧能对同一份原始 JSON 解析,而不是重新拼一遍。
	RawBodies map[string]string `json:"rawBodies"`
}

func loadQueueVectors(t *testing.T) queueVectorFile {
	t.Helper()
	p := filepath.Join("..", "..", "..", "..", "testdata", "task_queue_vectors.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读取向量失败: %v", err)
	}
	var vf queueVectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	return vf
}

// TestIdempotencyKeyMatchesJS 锁死跨语言幂等键。
//
// 这是整个迁移里最不能出错的地方:键不一致意味着 QStash 会把同一条
// 消息当新消息重复投递,用户表现为「同一个文件被传两次」。
func TestIdempotencyKeyMatchesJS(t *testing.T) {
	vf := loadQueueVectors(t)
	if len(vf.Keys) == 0 {
		t.Fatal("向量为空,需重跑 npm run test:vectors:task-queue")
	}

	for _, v := range vf.Keys {
		got := IdempotencyKey(v.Topic, v.Type, v.TaskID, v.Attempt)
		if got != v.Key {
			t.Errorf("IdempotencyKey(%q,%q,%q,%v) = %q,JS = %q",
				v.Topic, v.Type, v.TaskID, deref(v.Attempt), got, v.Key)
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestNormalizeAttemptMatchesJS(t *testing.T) {
	vf := loadQueueVectors(t)
	seen := map[string]bool{}
	for _, v := range vf.Keys {
		key := deref(v.Attempt)
		if seen[key] {
			continue
		}
		seen[key] = true
		if got := NormalizeQueueAttempt(v.Attempt); got != v.Normalized {
			t.Errorf("NormalizeQueueAttempt(%s) = %q,JS = %q", key, got, v.Normalized)
		}
	}
}

// TestParsePayloadMatchesJS 覆盖 JS 的 || 回退语义。
func TestParsePayloadMatchesJS(t *testing.T) {
	vf := loadQueueVectors(t)
	now := time.Now()

	for _, v := range vf.Payloads {
		body, ok := vf.RawBodies[v.Name]
		if !ok {
			t.Fatalf("缺少 %s 的原始 body,需重跑 npm run test:vectors:task-queue", v.Name)
		}
		got := ParseTaskQueuePayload([]byte(body), now)

		if got.TaskID != v.TaskID {
			t.Errorf("%s: taskId = %q,JS = %q", v.Name, got.TaskID, v.TaskID)
		}
		if got.Type != v.Type {
			t.Errorf("%s: type = %q,JS = %q", v.Name, got.Type, v.Type)
		}
		if got.GroupID != v.GroupID {
			t.Errorf("%s: groupId = %q,JS = %q", v.Name, got.GroupID, v.GroupID)
		}
		if got.Meta.TriggerSource != v.TriggerSource {
			t.Errorf("%s: triggerSource = %q,JS = %q", v.Name, got.Meta.TriggerSource, v.TriggerSource)
		}
		if got.Meta.InstanceID != v.InstanceID {
			t.Errorf("%s: instanceId = %q,JS = %q", v.Name, got.Meta.InstanceID, v.InstanceID)
		}
		if got.Meta.Timestamp == 0 {
			t.Errorf("%s: timestamp 应为非零", v.Name)
		}
	}
}

// TestParsePayloadMalformedInputNeverPanics 是信任边界:body 来自网络。
func TestParsePayloadMalformedInputNeverPanics(t *testing.T) {
	now := time.Now()
	for _, body := range []string{
		``, `{`, `null`, `[]`, `"str"`, `123`, `{"_meta":null}`, `{"_meta":[]}`,
		`{"taskId":123}`, `{"_meta":{"timestamp":"not-a-number"}}`,
		`{"taskId":"t","_meta":{"triggerSource":null}}`,
	} {
		got := ParseTaskQueuePayload([]byte(body), now)
		// 无论输入多畸形,都必须能安全降级,不能崩。
		if got.Meta.TriggerSource == "" {
			t.Errorf("%s: triggerSource 降级为空,应为 unknown", body)
		}
	}
}

// TestSafeIDLabel 锁死标签清洗规则 —— 改错会让幂等键整体漂移。
func TestSafeIDLabel(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"download", "download"},
		{"Download Tasks", "download-tasks"},
		{"a  b", "a-b"},   // 连续空格折叠成一个 -
		{"!!!", "x"},       // 全非法字符 → x
		{"--x--", "x"},    // 首尾 - 去掉
		{"任务_中文", "_"}, // 非 ASCII 折叠掉,但 _ 是合法字符故保留
		{"a/b/c", "a-b-c"}, // / 折叠
		{"keep_under-score", "keep_under-score"},
	} {
		if got := safeIDLabel(tc.in); got != tc.want {
			t.Errorf("safeIDLabel(%q) = %q,期望 %q", tc.in, got, tc.want)
		}
	}
	if got := safeIDLabel("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); len(got) != 24 {
		t.Errorf("超长标签应截断到 24,实际 %d", len(got))
	}
}