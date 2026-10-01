package contract

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// TaskQueueType 与 JS 侧 TASK_QUEUE_TYPES 对应。
const (
	QueueTypeDownload = "download"
	QueueTypeUpload   = "upload"
)

// 触发来源,与 JS 侧 TASK_QUEUE_TRIGGER_SOURCES 逐字对应。
const (
	TriggerQStash         = "qstash-v2"
	TriggerDirectQStash   = "direct-qstash"
	TriggerManualRetry    = "manual-retry"
	TriggerDownloadDone   = "download-complete"
	TriggerLocalFileReady = "local-file-ready"
)

// DefaultQueueAttempt 与 TASK_QUEUE_DEFAULT_ATTEMPT 对应。
const DefaultQueueAttempt = "initial"

// NormalizeQueueAttempt 对应 normalizeTaskQueueAttempt。
func NormalizeQueueAttempt(a *string) string {
	if a == nil {
		return DefaultQueueAttempt
	}
	if n := strings.TrimSpace(*a); n != "" {
		return n
	}
	return DefaultQueueAttempt
}

// safeIDLabel 复刻 JS 的 safeIdLabel:小写、非字母数字折叠成 "-"、
// 去首尾 "-"、最长 24,空则 "x"。
func safeIDLabel(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
			prevDash = r == '-'
			continue
		}
		// 非允许字符 → 折叠成单个 "-"
		if !prevDash {
			b.WriteRune('-')
			prevDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "x"
	}
	if len(out) > 24 {
		// JS 的 slice 按 UTF-16 code unit,label 只含 ASCII,按字节等价。
		out = out[:24]
	}
	return out
}

// IdempotencyKey 复刻 buildTaskQueueIdempotencyKey。
//
// 这个键决定 QStash 是否会重复投递同一条消息。JS 侧一旦改动这里的
// 任何一个字节(safeIdLabel 规则 / JSON.stringify 的分隔符 /
// base64url 编码),线上就会出现重复消费 —— 所以必须逐字对齐,
// 并由跨语言向量锁死。
func IdempotencyKey(topic, typ, taskID string, attempt *string) string {
	norm := NormalizeQueueAttempt(attempt)

	// JS: JSON.stringify([topic, type, taskId, attempt])
	// 四元素数组,无空格分隔。手工拼以保证与 JS 逐字节一致。
	var b strings.Builder
	b.WriteByte('[')
	writeJSONString(&b, topic)
	b.WriteByte(',')
	writeJSONString(&b, typ)
	b.WriteByte(',')
	writeJSONString(&b, taskID)
	b.WriteByte(',')
	writeJSONString(&b, norm)
	b.WriteByte(']')

	sum := sha256.Sum256([]byte(b.String()))
	digest := base64.RawURLEncoding.EncodeToString(sum[:])

	return "tqv1_" + safeIDLabel(topic) + "_" + safeIDLabel(typ) + "_" + digest
}

// writeJSONString 输出与 JSON.stringify 一致的带引号字符串。
// 入参都是我们自己拼的 ASCII 值,无需处理 Unicode 转义。
func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// TaskQueueMeta 对应 parseTaskQueuePayload 返回的 meta。
type TaskQueueMeta struct {
	TriggerSource string
	InstanceID    string
	Timestamp     int64
}

// TaskQueuePayload 对应 parseTaskQueuePayload 的返回值。
type TaskQueuePayload struct {
	TaskID  string
	Type    string
	GroupID string
	Meta    TaskQueueMeta
}

// ParseTaskQueuePayload 复刻 parseTaskQueuePayload。
//
// 注意 groupId 的回退顺序:payload.groupId 优先,其次 _meta.groupId。
// JS 用 || 处理,空串和 null 一样会回退 —— Go 这里用 empty() 对齐。
func ParseTaskQueuePayload(raw []byte, now time.Time) TaskQueuePayload {
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(raw, &doc) // 解析失败时 doc 为 nil,后续走默认值,与 JS 的 undefined 语义一致

	out := TaskQueuePayload{
		Meta: TaskQueueMeta{
			TriggerSource: "unknown",
			InstanceID:    "unknown",
			Timestamp:     now.UnixMilli(),
		},
	}
	if doc == nil {
		return out
	}

	out.TaskID = firstNonEmpty(rawString(doc["taskId"]), "")
	out.Type = firstNonEmpty(rawString(doc["type"]), "")

	var meta map[string]json.RawMessage
	if m, ok := doc["_meta"]; ok {
		_ = json.Unmarshal(m, &meta)
	}
	if meta == nil {
		meta = map[string]json.RawMessage{}
	}

	out.GroupID = firstNonEmpty(rawString(doc["groupId"]), rawString(meta["groupId"]), "")
	out.Meta.TriggerSource = firstNonEmpty(rawString(meta["triggerSource"]), "unknown")
	out.Meta.InstanceID = firstNonEmpty(rawString(meta["instanceId"]), "unknown")
	if ts := rawInt(meta["timestamp"]); ts != 0 {
		out.Meta.Timestamp = ts
	}
	return out
}

func rawString(r json.RawMessage) string {
	if len(r) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(r, &s); err != nil {
		return ""
	}
	return s
}

func rawInt(r json.RawMessage) int64 {
	if len(r) == 0 {
		return 0
	}
	var f float64
	if err := json.Unmarshal(r, &f); err != nil {
		return 0
	}
	return int64(f)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
