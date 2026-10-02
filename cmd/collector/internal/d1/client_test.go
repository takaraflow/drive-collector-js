package d1

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newTestClient(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	c, err := New(Config{
		AccountID:  "acct",
		DatabaseID: "db",
		Token:      "tok",
		BaseURL:    srv.URL,
		Log:        quiet(),
	})
	if err != nil {
		srv.Close()
		t.Fatalf("构造失败: %v", err)
	}
	return c, srv
}

// TestRequestShape 验证请求体与 Cloudflare REST 契约一致。
//
// 格式错了会得到「能编译但全部查询失败」——所以这里逐字段断言。
func TestRequestShape(t *testing.T) {
	var gotBody map[string]interface{}
	var gotPath, gotAuth, gotMethod string

	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Write([]byte(`{"success":true,"result":[{"success":true,"results":[]}]}`))
	})
	defer srv.Close()

	if _, err := c.Execute(context.Background(), "SELECT 1 WHERE id = ?", "abc"); err != nil {
		t.Fatal(err)
	}

	if gotMethod != http.MethodPost {
		t.Errorf("method = %q,期望 POST", gotMethod)
	}
	wantPath := "/accounts/acct/d1/database/db/query"
	if gotPath != wantPath {
		t.Errorf("path = %q,期望 %q", gotPath, wantPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotBody["sql"] != "SELECT 1 WHERE id = ?" {
		t.Errorf("sql = %v", gotBody["sql"])
	}
	params, ok := gotBody["params"].([]interface{})
	if !ok || len(params) != 1 || params[0] != "abc" {
		t.Errorf("params = %#v", gotBody["params"])
	}
}

// TestNilParamsBecomesEmptyArray 无参数时必须发 [] 而不是 null。
//
// Cloudflare 对 params: null 的行为与 [] 不同,前者可能报错。
func TestNilParamsBecomesEmptyArray(t *testing.T) {
	var raw map[string]interface{}
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &raw)
		w.Write([]byte(`{"success":true,"result":[{"success":true,"results":[]}]}`))
	})
	defer srv.Close()

	if _, err := c.Execute(context.Background(), "SELECT 1"); err != nil {
		t.Fatal(err)
	}
	params, ok := raw["params"].([]interface{})
	if !ok {
		t.Fatalf("params = %#v,期望是数组(不能是 null)", raw["params"])
	}
	if len(params) != 0 {
		t.Errorf("params 长度 = %d,期望 0", len(params))
	}
}

// TestRetryOn5xx 5xx 是 Cloudflare 侧临时故障,必须重试。
func TestRetryOn5xx(t *testing.T) {
	var calls int32
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) < 3 {
			w.WriteHeader(502)
			w.Write([]byte(`{"success":false,"errors":[{"code":1,"message":"bad gateway"}]}`))
			return
		}
		w.Write([]byte(`{"success":true,"result":[{"success":true,"results":[{"id":"t1"}],"meta":{"rows_written":1}}]}`))
	})
	defer srv.Close()

	rows, err := c.Execute(context.Background(), "SELECT id FROM tasks")
	if err != nil {
		t.Fatalf("重试后应成功,得到 %v", err)
	}
	if atomic.LoadInt32(&calls) != 3 {
		t.Errorf("调用次数 = %d,期望 3", calls)
	}
	if len(rows) != 1 || rows[0]["id"] != "t1" {
		t.Errorf("行 = %#v", rows)
	}
}

// TestNoRetryOn4xx SQL 错误(约束冲突等)是 4xx,重试没意义。
func TestNoRetryOn4xx(t *testing.T) {
	var calls int32
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(400)
		w.Write([]byte(`{"success":false,"errors":[{"code":1,"message":"UNIQUE constraint failed"}]}`))
	})
	defer srv.Close()

	if _, err := c.Execute(context.Background(), "INSERT ..."); err == nil {
		t.Fatal("4xx 应报错")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("4xx 调用次数 = %d,期望 1(不该重试)", got)
	}
}

// TestFetchOneReturnsNilWhenAbsent 查不到是正常业务分支,不是错误。
func TestFetchOneReturnsNilWhenAbsent(t *testing.T) {
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"success":true,"result":[{"success":true,"results":[]}]}`))
	})
	defer srv.Close()

	row, err := c.FetchOne(context.Background(), "SELECT id FROM tasks WHERE id = ?", "nope")
	if err != nil {
		t.Fatalf("查不到不应报错,得到 %v", err)
	}
	if row != nil {
		t.Errorf("row = %#v,期望 nil", row)
	}
}

// TestExecReturnsRowsWritten 写语句要返回受影响行数。
func TestExecReturnsRowsWritten(t *testing.T) {
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"success":true,"result":[{"success":true,"results":[],"meta":{"rows_written":3}}]}`))
	})
	defer srv.Close()

	n, err := c.Exec(context.Background(), "UPDATE tasks SET status = ?", "completed")
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("rows_written = %d,期望 3", n)
	}
}

// TestCloudflareErrorIsSurfaced D1 的业务错误必须能被读懂。
func TestCloudflareErrorIsSurfaced(t *testing.T) {
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"success":false,"errors":[{"code":1003,"message":"D1_ERROR: no such table: taskz"}]}`))
	})
	defer srv.Close()

	_, err := c.Execute(context.Background(), "SELECT * FROM taskz")
	if err == nil {
		t.Fatal("应报错")
	}
	if !strings.Contains(err.Error(), "no such table") {
		t.Errorf("错误信息应包含 Cloudflare 的原文,得到 %q", err.Error())
	}
}

// TestNetworkErrorRetries 网络错误要重试。
func TestNetworkErrorRetries(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	}))
	// 先构造客户端再关服务器,制造连接失败
	c, err := New(Config{
		AccountID: "a", DatabaseID: "d", Token: "t",
		BaseURL: srv.URL, Log: quiet(),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv.Close()

	_, execErr := c.Execute(context.Background(), "SELECT 1")
	if execErr == nil {
		t.Fatal("连接失败应报错")
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Errorf("关闭后不该有成功请求,计数 = %d", got)
	}
	if !strings.Contains(execErr.Error(), "重试") {
		t.Errorf("错误信息应说明重试过,得到 %q", execErr.Error())
	}
}

// TestNewRejectsIncompleteConfig 配置不全必须硬失败 ——
// 缺 Token 时静默降级等于无保护访问。
func TestNewRejectsIncompleteConfig(t *testing.T) {
	cases := []Config{
		{DatabaseID: "d", Token: "t"},
		{AccountID: "a", Token: "t"},
		{AccountID: "a", DatabaseID: "d"},
	}
	for i, cfg := range cases {
		cfg.Log = quiet()
		if _, err := New(cfg); err == nil {
			t.Errorf("case %d: 配置不完整应报错", i)
		}
	}
}
