package axiom

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHandler_NormalIngest(t *testing.T) {
	var (
		mu           sync.Mutex
		receivedLogs []LogEvent
		authHeader   string
		orgHeader    string
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		authHeader = r.Header.Get("Authorization")
		orgHeader = r.Header.Get("X-Axiom-Org-Id")

		body, _ := io.ReadAll(r.Body)
		var events []LogEvent
		_ = json.Unmarshal(body, &events)
		receivedLogs = append(receivedLogs, events...)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHandler(Config{
		Token:         "test-token",
		OrgID:         "test-org",
		Dataset:       "test-dataset",
		InstanceID:    "inst-01",
		BaseURL:       srv.URL,
		BatchSize:     2,
		FlushInterval: 50 * time.Millisecond,
		QueueSize:     10,
	}, nil)

	logger := slog.New(h)
	logger.Info("hello axiom", "user_id", "u123", "task_id", "t456")
	logger.Warn("disk getting full", "available_mb", 512)

	// 等待批处理自动 flush
	time.Sleep(150 * time.Millisecond)

	_ = h.Close()

	mu.Lock()
	defer mu.Unlock()

	if authHeader != "Bearer test-token" {
		t.Errorf("expected Bearer test-token, got %s", authHeader)
	}
	if orgHeader != "test-org" {
		t.Errorf("expected test-org, got %s", orgHeader)
	}
	if len(receivedLogs) != 2 {
		t.Fatalf("expected 2 logs received, got %d", len(receivedLogs))
	}

	ev1 := receivedLogs[0]
	if ev1["message"] != "hello axiom" {
		t.Errorf("expected hello axiom, got %v", ev1["message"])
	}
	if ev1["level"] != "info" {
		t.Errorf("expected info level, got %v", ev1["level"])
	}
	if ev1["user_id"] != "u123" {
		t.Errorf("expected user_id u123, got %v", ev1["user_id"])
	}
	if ev1["instanceId"] != "inst-01" {
		t.Errorf("expected instanceId inst-01, got %v", ev1["instanceId"])
	}
	if ev1["_time"] == nil || ev1["timestamp"] == nil {
		t.Error("expected _time and timestamp in log event")
	}
}

func TestHandler_WithAttrsAndGroup(t *testing.T) {
	var (
		mu           sync.Mutex
		receivedLogs []LogEvent
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		var events []LogEvent
		_ = json.Unmarshal(body, &events)
		receivedLogs = append(receivedLogs, events...)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHandler(Config{
		Token:         "token-abc",
		BaseURL:       srv.URL,
		BatchSize:     1,
		FlushInterval: 20 * time.Millisecond,
	}, nil)

	logger := slog.New(h).With("component", "storage").WithGroup("details")
	logger.Error("write failed", "path", "/tmp/file", "errno", 28)

	time.Sleep(100 * time.Millisecond)
	_ = h.Close()

	mu.Lock()
	defer mu.Unlock()

	if len(receivedLogs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(receivedLogs))
	}
	ev := receivedLogs[0]
	if ev["component"] != "storage" {
		t.Errorf("expected component storage, got %v", ev["component"])
	}
	grp, ok := ev["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected details group map, got: %#v", ev["details"])
	}
	if grp["path"] != "/tmp/file" {
		t.Errorf("expected path /tmp/file, got %v", grp["path"])
	}
}

func TestHandler_QueueFullDropsNonBlocking(t *testing.T) {
	// 创建一个挂起的 server，模拟极慢网络
	blockCh := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-blockCh
		w.WriteHeader(http.StatusOK)
	}))
	defer func() {
		close(blockCh)
		srv.Close()
	}()

	// 极小的队列大小与短超时，用于测试满载丢弃
	h := NewHandler(Config{
		Token:         "test-token",
		BaseURL:       srv.URL,
		BatchSize:     5,
		FlushInterval: 1 * time.Second,
		QueueSize:     3,
		HTTPClient:    &http.Client{Timeout: 50 * time.Millisecond},
	}, nil)

	// 瞬间投递 20 条日志，必须立即返回，不能发生死锁或阻塞
	done := make(chan struct{})
	go func() {
		for i := 0; i < 20; i++ {
			_ = h.Handle(context.Background(), slog.NewRecord(time.Now(), slog.LevelInfo, "spam log", 0))
		}
		close(done)
	}()

	select {
	case <-done:
		// 成功，说明是非阻塞的
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Handle blocked when queue was full")
	}

	if h.DroppedCount() == 0 {
		t.Error("expected dropped logs when queue overflowed, got 0")
	}

	_ = h.Close()
}

func TestHandler_BackoffOn500(t *testing.T) {
	var reqCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqCount.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := NewHandler(Config{
		Token:         "test-token",
		BaseURL:       srv.URL,
		BatchSize:     1,
		FlushInterval: 10 * time.Millisecond,
	}, nil)

	logger := slog.New(h)
	logger.Info("trigger error")

	time.Sleep(50 * time.Millisecond)

	if reqCount.Load() == 0 {
		t.Error("expected at least one request")
	}

	// 验证进入熔断退避期
	now := time.Now().UnixMilli()
	if now >= h.suspended.Load() {
		t.Errorf("expected suspended until > now, got %d vs %d", h.suspended.Load(), now)
	}

	_ = h.Close()
}

func TestHandler_FlushOnClose(t *testing.T) {
	var (
		mu           sync.Mutex
		receivedLogs []LogEvent
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		var events []LogEvent
		_ = json.Unmarshal(body, &events)
		receivedLogs = append(receivedLogs, events...)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHandler(Config{
		Token:         "test-token",
		BaseURL:       srv.URL,
		BatchSize:     100,             // 大批次，不靠满了触发
		FlushInterval: 1 * time.Minute, // 慢周期，不靠定时器触发
	}, nil)

	logger := slog.New(h)
	logger.Info("close log 1")
	logger.Info("close log 2")

	// 立即 Close，验证优雅退出时会将积压的日志刷出
	if err := h.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()

	if len(receivedLogs) != 2 {
		t.Fatalf("expected 2 logs flushed on close, got %d", len(receivedLogs))
	}
}
