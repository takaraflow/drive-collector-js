package edge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/leader"
	"github.com/youngsx/drive-collector/cmd/collector/internal/qstash"
)

const testKey = "edge-test-signing-key"

func newServer(t *testing.T, l *leader.Resolver, upstream *httptest.Server) *Server {
	t.Helper()
	cfg := Config{
		Log:        discardLogger(),
		InstanceID: "edge-1",
		Receiver:   &qstash.Receiver{CurrentSigningKey: testKey},
		Leader:     l,
	}
	// 端点级测试(健康/版本)不需要上游 —— 之前无条件
	// upstream.Client() 会在 nil 上崩。
	if upstream != nil {
		cfg.Outbound = upstream.Client()
	}
	return New(cfg)
}

func leaderWith(base string) *leader.Resolver {
	return &leader.Resolver{
		LockGetter: func(ctx context.Context, key string) ([]byte, error) {
			return []byte(`{"instanceId":"inst-1"}`), nil
		},
		ActiveLister: func(ctx context.Context) ([]leader.Instance, error) {
			return []leader.Instance{{ID: "inst-1", DirectURL: base}}, nil
		},
	}
}

func leaderMissing() *leader.Resolver {
	return &leader.Resolver{
		LockGetter: func(ctx context.Context, key string) ([]byte, error) {
			return nil, nil
		},
		ActiveLister: func(ctx context.Context) ([]leader.Instance, error) {
			return nil, nil
		},
	}
}

// signedRequest 用真实 HMAC 构造一个合法请求,而不是跳过验签 ——
// 跳过验签的测试等于没测验签。
func signedRequest(t *testing.T, method, target string, body []byte, key string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(string(body)))
	r.Host = "lb.example.com"
	sig, err := signFor(r, body, key)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Upstash-Signature", sig)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func do(t *testing.T, s *Server, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	return rec
}

const taskBody = `{"taskId":"t-1","type":"download"}`

// TestForwardsValidSignedTask 是核心路径:合法签名 → 转发 leader。
func TestForwardsValidSignedTask(t *testing.T) {
	var gotPath, gotBody, gotFwd string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotFwd = r.Header.Get("X-Forwarded-By-Instance")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer upstream.Close()

	s := newServer(t, leaderWith(upstream.URL), upstream)
	rec := do(t, s, signedRequest(t, "POST", "/api/v2/tasks/download", []byte(taskBody), testKey))

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d,期望 200(body=%s)", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/v2/tasks/download" {
		t.Errorf("转发路径 = %q", gotPath)
	}
	// body 必须逐字节保持 —— 变了签名就失效
	if gotBody != taskBody {
		t.Errorf("转发 body = %q,期望 %q", gotBody, taskBody)
	}
	if gotFwd != "edge-1" {
		t.Errorf("X-Forwarded-By-Instance = %q", gotFwd)
	}
}

// TestRejectsBadSignature 确认验签真的在拦。
func TestRejectsBadSignature(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("验签失败时不应转发")
	}))
	defer upstream.Close()

	s := newServer(t, leaderWith(upstream.URL), upstream)

	cases := []struct {
		name string
		req  func() *http.Request
	}{
		{"无签名头", func() *http.Request {
			r := httptest.NewRequest("POST", "/api/v2/tasks/download", strings.NewReader(taskBody))
			r.Host = "lb.example.com"
			return r
		}},
		{"body 被篡改", func() *http.Request {
			r := signedRequest(t, "POST", "/api/v2/tasks/download", []byte(taskBody), testKey)
			r.Body = io.NopCloser(strings.NewReader(`{"taskId":"evil"}`))
			return r
		}},
		{"错误 key 签名", func() *http.Request {
			return signedRequest(t, "POST", "/api/v2/tasks/download", []byte(taskBody), "attacker")
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, s, tc.req())
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("状态码 = %d,期望 401", rec.Code)
			}
		})
	}
}

// TestNoLeaderReturns503 与 JS 侧 "Not Leader" 契约一致:
// 让 QStash 重试,而不是丢弃。
func TestNoLeaderReturns503(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("无 leader 时不应转发")
	}))
	defer upstream.Close()

	s := newServer(t, leaderMissing(), upstream)
	rec := do(t, s, signedRequest(t, "POST", "/api/v2/tasks/download", []byte(taskBody), testKey))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d,期望 503", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if msg, _ := body["message"].(string); !strings.Contains(msg, "Not Leader") {
		t.Errorf("message = %q,期望含 'Not Leader'", msg)
	}
}

// TestUpstreamUnreachableIsRetryable 转发失败必须 5xx,否则 QStash
// 认为投递成功,任务就永远丢了。
func TestUpstreamUnreachableIsRetryable(t *testing.T) {
	// 上游立刻关闭,模拟 leader 正在重启
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := upstream.URL
	upstream.Close()

	s := newServer(t, leaderWith(url), upstream)
	rec := do(t, s, signedRequest(t, "POST", "/api/v2/tasks/download", []byte(taskBody), testKey))

	if rec.Code < 500 {
		t.Errorf("状态码 = %d,期望 5xx 以触发 QStash 重试", rec.Code)
	}
}

// TestNonTaskPathsNotHandled 确认边缘节点不越界接管。
func TestNonTaskPathsNotHandled(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()

	s := newServer(t, leaderWith(upstream.URL), upstream)

	// 健康与版本端点本节点自己实现(平台探针打的就是它们),
	// 但只答 GET/HEAD —— POST 一律 405。
	for _, p := range []string{"/health", "/healthz", "/version"} {
		t.Run(p, func(t *testing.T) {
			rec := do(t, s, signedRequest(t, "POST", p, []byte(taskBody), testKey))
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s POST 状态码 = %d,期望 405", p, rec.Code)
			}
		})
	}

	// 这些仍由 Node 处理,本节点不接管。
	for _, p := range []string{"/api/v2/stream/x", "/api/v2/config/refresh"} {
		t.Run(p, func(t *testing.T) {
			rec := do(t, s, signedRequest(t, "POST", p, []byte(taskBody), testKey))
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s 状态码 = %d,期望 404(不接管)", p, rec.Code)
			}
		})
	}
}

// TestRejectsNonPost 确认方法限制。
func TestRejectsNonPost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()

	s := newServer(t, leaderWith(upstream.URL), upstream)
	r := httptest.NewRequest("GET", "/api/v2/tasks/download", nil)
	rec := do(t, s, r)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("状态码 = %d,期望 405", rec.Code)
	}
}

// TestInvalidJSONAfterValidSignature 签名对了但 body 非法 JSON → 400。
// 这条路径必须与 JS 侧 Invalid JSON 契约一致。
func TestInvalidJSONAfterValidSignature(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()

	s := newServer(t, leaderWith(upstream.URL), upstream)
	rec := do(t, s, signedRequest(t, "POST", "/api/v2/tasks/download", []byte(`{bad json`), testKey))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("状态码 = %d,期望 400", rec.Code)
	}
}

// TestOversizedBodyRejected 防止超大 body 打爆内存。
func TestOversizedBodyRejected(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()

	s := newServer(t, leaderWith(upstream.URL), upstream)
	huge := make([]byte, MaxBodyBytes+1024)
	for i := range huge {
		huge[i] = 'a'
	}
	rec := do(t, s, signedRequest(t, "POST", "/api/v2/tasks/download", huge, testKey))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("状态码 = %d,期望 400(超大 body 应被拒)", rec.Code)
	}
}

// TestSystemEventsForwardsWithoutLeaderLock system-events 是本实例事件,
// 不该因为拿不到 Telegram 锁而被拒。
func TestSystemEventsForwardsWithoutLeaderLock(t *testing.T) {
	var called bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	// 锁存在但实例列表里没有它 → BaseURL 返回 ""
	stale := &leader.Resolver{
		LockGetter: func(ctx context.Context, key string) ([]byte, error) {
			return []byte(`{"instanceId":"gone"}`), nil
		},
		ActiveLister: func(ctx context.Context) ([]leader.Instance, error) {
			return []leader.Instance{{ID: "other", DirectURL: upstream.URL}}, nil
		},
	}

	s := newServer(t, stale, upstream)
	rec := do(t, s, signedRequest(t, "POST", "/api/v2/tasks/system-events", []byte(`{"event":"media_group_flush"}`), testKey))

	if rec.Code == http.StatusServiceUnavailable {
		t.Errorf("system-events 不应因缺 leader 被拒")
	}
	_ = called
}

// TestHealthEndpointsAreReachable 平台探针打的就是这两个路径。
//
// 缺了它们,容器会被判定不健康并无限重启 —— 而且探针失败时容器
// 根本来不及打印有用日志,只剩一句重启循环。
func TestHealthEndpointsAreReachable(t *testing.T) {
	s := newServer(t, nil, nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("/health = %d,期望 200(平台探针靠它判断存活)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("响应体 = %q", rec.Body.String())
	}

	// /healthz 是别名,探针两个都打
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, httptest.NewRequest("GET", "/healthz", nil))
	if rec2.Code != http.StatusOK {
		t.Errorf("/healthz = %d,期望 200", rec2.Code)
	}
}

// TestHealthRejectsPost 健康端点只答 GET/HEAD。
func TestHealthRejectsPost(t *testing.T) {
	s := newServer(t, nil, nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/health", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /health = %d,期望 405", rec.Code)
	}
}

// TestVersionReportsBuildIdentity /version 用来确认线上跑的是哪个版本。
func TestVersionReportsBuildIdentity(t *testing.T) {
	t.Setenv("APP_VERSION", "4.33.8-go")
	t.Setenv("GIT_SHA", "abc1234")

	s := newServer(t, nil, nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/version", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("/version = %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["version"] != "4.33.8-go" {
		t.Errorf("version = %v", body["version"])
	}
	if body["sha"] != "abc1234" {
		t.Errorf("sha = %v", body["sha"])
	}
	// mode 让人一眼看出这是 edge 还是 worker 实例
	if body["mode"] == nil {
		t.Error("响应里应有 mode 字段")
	}
}
