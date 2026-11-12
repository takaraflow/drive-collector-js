package shortshare

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newTestClient(ts *httptest.Server) *http.Client {
	tsURL, _ := url.Parse(ts.URL)
	return &http.Client{
		Transport: &mockRoundTripper{
			handler: func(req *http.Request) (*http.Response, error) {
				cloned := req.Clone(req.Context())
				cloned.URL.Scheme = tsURL.Scheme
				cloned.URL.Host = tsURL.Host
				return ts.Client().Transport.RoundTrip(cloned)
			},
		},
	}
}

type mockRoundTripper struct {
	handler func(*http.Request) (*http.Response, error)
}

func (m *mockRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return m.handler(req)
}

func TestExtract_NoPasswordNeeded(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`
			<!DOCTYPE html>
			<html>
			<head><title>公开视频分享</title></head>
			<body>
				<h1>精彩短视频</h1>
				<video src="https://cdn.lurl.cc/video123.mp4"></video>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	codeID := "vid123"
	client := NewClient(WithHTTPClient(newTestClient(ts)))

	res, err := client.Extract(context.Background(), fmt.Sprintf("https://lurl.cc/%s", codeID), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(res.Items))
	}
	if res.Items[0].URL != "https://cdn.lurl.cc/video123.mp4" {
		t.Errorf("expected video URL, got %s", res.Items[0].URL)
	}
	if res.Items[0].Headers["Referer"] != fmt.Sprintf("https://lurl.cc/%s", codeID) {
		t.Errorf("expected Referer header set, got %v", res.Items[0].Headers)
	}
}

func TestExtract_DatePasswordFromUploadSpan(t *testing.T) {
	var receivedCookie string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, _ := r.Cookie("psc_sec789")
		if cookie != nil {
			receivedCookie = cookie.Value
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if receivedCookie == "1113" {
			_, _ = w.Write([]byte(`
				<html>
				<body>
					<h2><span>成功</span></h2>
					<link rel="preload" as="image" href="https://img.lurl.cc/photo1.jpg">
					<link rel="preload" as="image" href="https://img.lurl.cc/photo2.jpg">
				</body>
				</html>
			`))
			return
		}

		_, _ = w.Write([]byte(`
			<html>
			<body>
				<span class="login_span">上传日期：2026-11-13</span>
				<div id="pasahaicsword">请输入密码</div>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	client := NewClient(WithHTTPClient(newTestClient(ts)))

	res, err := client.Extract(context.Background(), "https://lurl.cc/sec789", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.PasswordUsed != "1113" {
		t.Errorf("expected password used 1113, got %s", res.PasswordUsed)
	}
	if len(res.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(res.Items))
	}
}

func TestExtract_DatePasswordFromCSTToday(t *testing.T) {
	fixedTime := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	var receivedCookie string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, _ := r.Cookie("psc_today99")
		if cookie != nil {
			receivedCookie = cookie.Value
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if receivedCookie == "1113" {
			_, _ = w.Write([]byte(`
				<html>
				<body>
					<video src="https://cdn.myppt.cc/today.mp4"></video>
				</body>
				</html>
			`))
			return
		}

		_, _ = w.Write([]byte(`
			<html>
			<body>
				<div>请输入访问密码</div>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	client := NewClient(
		WithHTTPClient(newTestClient(ts)),
		WithNowFunc(func() time.Time { return fixedTime }),
	)

	res, err := client.Extract(context.Background(), "https://myppt.cc/today99", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.PasswordUsed != "1113" {
		t.Errorf("expected password 1113, got %s", res.PasswordUsed)
	}
	if len(res.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(res.Items))
	}
}

func TestExtract_PasswordRequiredWhenDefaultFails(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`
			<html>
			<body>
				<span class="login_span">上传日期：2026-05-20</span>
				<div class="login_box">
					<h2><span>請輸入密碼</span></h2>
				</div>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	client := NewClient(WithHTTPClient(newTestClient(ts)))

	_, err := client.Extract(context.Background(), "https://lurl.cc/needpass", "")
	if !errors.Is(err, ErrPasswordRequired) {
		t.Fatalf("expected ErrPasswordRequired, got %v", err)
	}
}

func TestExtract_UserSuppliedPassword(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		cookie, _ := r.Cookie("psc_userpwd")
		if cookie != nil && cookie.Value == "secret99" {
			_, _ = w.Write([]byte(`
				<html>
				<body>
					<video src="https://cdn.lurl.cc/private.mp4"></video>
				</body>
				</html>
			`))
			return
		}
		_, _ = w.Write([]byte(`
			<html>
			<body>
				<h2><span>密碼錯誤</span></h2>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	client := NewClient(WithHTTPClient(newTestClient(ts)))

	// 错误密码
	_, err := client.Extract(context.Background(), "https://lurl.cc/userpwd", "wrong")
	if !errors.Is(err, ErrPasswordWrong) {
		t.Fatalf("expected ErrPasswordWrong, got %v", err)
	}

	// 正确密码
	res, err := client.Extract(context.Background(), "https://lurl.cc/userpwd", "secret99")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].URL != "https://cdn.lurl.cc/private.mp4" {
		t.Errorf("unexpected items: %v", res.Items)
	}
}

func TestExtract_ExpiredPage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`
			<html>
			<head><title>404</title></head>
			<body>
				<h1>該連結已過期</h1>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	client := NewClient(WithHTTPClient(newTestClient(ts)))

	_, err := client.Extract(context.Background(), "https://lurl.cc/expired1", "")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestExtract_AntiBotBlocked(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`
			<html>
			<head><title>Attention Required! | Cloudflare</title></head>
			<body>
				<div class="cf-browser-verification">Checking your browser before accessing...</div>
			</body>
			</html>
		`))
	}))
	defer ts.Close()

	client := NewClient(WithHTTPClient(newTestClient(ts)))

	_, err := client.Extract(context.Background(), "https://lurl.cc/blocked", "")
	if !errors.Is(err, ErrAntiBotBlocked) {
		t.Fatalf("expected ErrAntiBotBlocked, got %v", err)
	}
}

func TestExtract_FormPostWithCSRF(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method == http.MethodPost {
			_ = r.ParseForm()
			if r.FormValue("_token") == "csrf-secret-123" && r.FormValue("pasahaicsword") == "formpwd" {
				_, _ = w.Write([]byte(`
					<html><body>
						<link rel="preload" as="image" href="https://img.myppt.cc/gallery1.jpg">
					</body></html>
				`))
				return
			}
		}
		// Form page
		_, _ = w.Write([]byte(`
			<html><body>
				<form action="/login" method="POST">
					<input type="hidden" name="_token" value="csrf-secret-123">
					<input type="password" id="pasahaicsword" name="pasahaicsword">
				</form>
			</body></html>
		`))
	}))
	defer ts.Close()

	client := NewClient(WithHTTPClient(newTestClient(ts)))

	res, err := client.Extract(context.Background(), "https://myppt.cc/csrfcode", "formpwd")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Items) != 1 || !strings.Contains(res.Items[0].URL, "gallery1.jpg") {
		t.Errorf("unexpected items: %v", res.Items)
	}
}
