package axiom

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Config 配置 Axiom 异步日志推送。
type Config struct {
	Token         string
	OrgID         string
	Dataset       string
	InstanceID    string
	BaseURL       string // 默认 https://api.axiom.co，测试可注入 httptest.Server
	BatchSize     int
	FlushInterval time.Duration
	QueueSize     int
	HTTPClient    *http.Client
}

// LogEvent 序列化给 Axiom Ingest API 的单条事件。
type LogEvent map[string]interface{}

type prefixedAttr struct {
	groups []string
	attr   slog.Attr
}

// Handler 是支持异步批量投递的 slog.Handler。
type Handler struct {
	cfg           Config
	next          slog.Handler
	ch            chan LogEvent
	client        *http.Client
	done          chan struct{}
	wg            sync.WaitGroup
	prefixedAttrs []prefixedAttr
	currentGroups []string
	suspended     atomic.Int64 // UnixMilli: 熔断退避截止时间
	dropCount     atomic.Uint64
	closed        atomic.Bool
}

// NewHandler 创建 Axiom slog 处理器。如果传入了 next，则所有日志依然同步流经 next（如 stdout）。
func NewHandler(cfg Config, next slog.Handler) *Handler {
	if cfg.Dataset == "" {
		cfg.Dataset = "drive-collector"
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.axiom.co"
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = 3 * time.Second
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 1000
	}
	if cfg.InstanceID == "" {
		cfg.InstanceID = "unknown"
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}

	h := &Handler{
		cfg:    cfg,
		next:   next,
		ch:     make(chan LogEvent, cfg.QueueSize),
		client: client,
		done:   make(chan struct{}),
	}

	h.wg.Add(1)
	go h.worker()

	return h
}

// Enabled 检查日志级别。
func (h *Handler) Enabled(ctx context.Context, level slog.Level) bool {
	if h.next != nil {
		return h.next.Enabled(ctx, level)
	}
	return true
}

// Handle 处理单条日志记录：同步调用 next，并异步投递到 Axiom 批处理缓冲。
func (h *Handler) Handle(ctx context.Context, r slog.Record) error {
	var nextErr error
	if h.next != nil {
		nextErr = h.next.Handle(ctx, r)
	}

	// 如果未配置 Token 或已关闭，仅执行 next
	if h.cfg.Token == "" || h.closed.Load() {
		return nextErr
	}

	event := h.recordToEvent(r)

	// 非阻塞投递：若队列已满，则丢弃并递增计数，绝不阻塞转存主链路
	select {
	case h.ch <- event:
	default:
		h.dropCount.Add(1)
	}

	return nextErr
}

// WithAttrs 附带上下文属性。
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *h
	clone.prefixedAttrs = append([]prefixedAttr(nil), h.prefixedAttrs...)
	for _, a := range attrs {
		clone.prefixedAttrs = append(clone.prefixedAttrs, prefixedAttr{
			groups: append([]string(nil), h.currentGroups...),
			attr:   a,
		})
	}
	if h.next != nil {
		clone.next = h.next.WithAttrs(attrs)
	}
	return &clone
}

// WithGroup 附带分组名称。
func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	clone := *h
	clone.currentGroups = append(append([]string(nil), h.currentGroups...), name)
	if h.next != nil {
		clone.next = h.next.WithGroup(name)
	}
	return &clone
}

// DroppedCount 获取因队列满而丢弃的日志数量。
func (h *Handler) DroppedCount() uint64 {
	return h.dropCount.Load()
}

// Close 关闭后台 worker 并冲刷剩余日志。
func (h *Handler) Close() error {
	if h.closed.Swap(true) {
		return nil
	}
	close(h.done)
	h.wg.Wait()
	return nil
}

// ----------------------------------------------------------------------------
// 内部批处理与 Ingest
// ----------------------------------------------------------------------------

func (h *Handler) recordToEvent(r slog.Record) LogEvent {
	event := make(LogEvent)

	event["_time"] = r.Time.UTC().Format(time.RFC3339Nano)
	event["timestamp"] = r.Time.UTC().Format(time.RFC3339Nano)
	event["level"] = strings.ToLower(r.Level.String())
	event["message"] = r.Message
	event["instanceId"] = h.cfg.InstanceID

	// 注入唯一 eventId
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	event["eventId"] = fmt.Sprintf("%s_%d_%s", h.cfg.InstanceID, time.Now().UnixMilli(), hex.EncodeToString(b))

	// 收集预设属性（带有其所绑定的分组）
	for _, pa := range h.prefixedAttrs {
		h.setAttr(event, pa.attr, pa.groups)
	}

	// 收集记录内属性（使用当前最新分组）
	r.Attrs(func(attr slog.Attr) bool {
		h.setAttr(event, attr, h.currentGroups)
		return true
	})

	return event
}

func (h *Handler) setAttr(event LogEvent, attr slog.Attr, groups []string) {
	if attr.Key == "" {
		return
	}
	target := event
	for _, g := range groups {
		if sub, ok := target[g].(map[string]interface{}); ok {
			target = sub
		} else {
			sub = make(map[string]interface{})
			target[g] = sub
			target = sub
		}
	}
	target[attr.Key] = attr.Value.Any()
}

func (h *Handler) worker() {
	defer h.wg.Done()

	ticker := time.NewTicker(h.cfg.FlushInterval)
	defer ticker.Stop()

	batch := make([]LogEvent, 0, h.cfg.BatchSize)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		toSend := batch
		batch = make([]LogEvent, 0, h.cfg.BatchSize)
		h.sendBatch(toSend)
	}

	for {
		select {
		case ev := <-h.ch:
			batch = append(batch, ev)
			if len(batch) >= h.cfg.BatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-h.done:
			// 退出时把剩余日志全部抽尽
			for {
				select {
				case ev := <-h.ch:
					batch = append(batch, ev)
					if len(batch) >= h.cfg.BatchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		}
	}
}

func (h *Handler) sendBatch(batch []LogEvent) {
	if len(batch) == 0 || h.cfg.Token == "" {
		return
	}

	// 退避熔断检查
	now := time.Now().UnixMilli()
	if now < h.suspended.Load() {
		return
	}

	data, err := json.Marshal(batch)
	if err != nil {
		return
	}

	url := fmt.Sprintf("%s/v1/datasets/%s/ingest", strings.TrimRight(h.cfg.BaseURL, "/"), h.cfg.Dataset)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return
	}

	req.Header.Set("Authorization", "Bearer "+h.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	if h.cfg.OrgID != "" {
		req.Header.Set("X-Axiom-Org-Id", h.cfg.OrgID)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		// 网络不可用，退避 3 秒
		h.suspended.Store(time.Now().Add(3 * time.Second).UnixMilli())
		return
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode >= 500 {
		// 服务端错误，退避 3 秒
		h.suspended.Store(time.Now().Add(3 * time.Second).UnixMilli())
	}
}
