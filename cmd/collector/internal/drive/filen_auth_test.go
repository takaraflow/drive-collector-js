package drive

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeriveFilenPassword(t *testing.T) {
	// 验证相同的输入必定产生确定性的 SHA-512 派生值
	pwd := "MyFilenSecretPassword#123"
	salt := "test-filen-salt-abc-123"

	hash1 := DeriveFilenPassword(pwd, salt)
	hash2 := DeriveFilenPassword(pwd, salt)

	if hash1 == "" || len(hash1) != 128 {
		t.Fatalf("派生哈希长度不正确，期望 128 字符 (SHA-512 hex)，得到: %s (len=%d)", hash1, len(hash1))
	}
	if hash1 != hash2 {
		t.Fatalf("派生哈希非确定性: %s vs %s", hash1, hash2)
	}
}

func TestHTTPFilenClient_Login(t *testing.T) {
	ctx := context.Background()

	// 模拟 Filen Gateway 服务
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v3/auth/info":
			var req map[string]string
			_ = json.NewDecoder(r.Body).Decode(&req)
			if req["email"] == "notfound@filen.io" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status":  false,
					"message": "User not found",
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":  true,
				"message": "OK",
				"data": map[string]any{
					"salt":        "sample-filen-salt",
					"authVersion": 2,
				},
			})
		case "/v3/login":
			var req map[string]any
			_ = json.NewDecoder(r.Body).Decode(&req)
			email := req["email"]
			code := req["twoFactorCode"]

			if email == "twofa@filen.io" && code == "XXXXXX" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status":  false,
					"message": "2FA required",
					"code":    "TWO_FACTOR_AUTHENTICATION_REQUIRED",
				})
				return
			}

			if email == "wrongpass@filen.io" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status":  false,
					"message": "Invalid password",
				})
				return
			}

			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":  true,
				"message": "OK",
				"data": map[string]any{
					"apiKey": "mock_filen_api_key_xyz_789",
				},
			})
		default:
			http.NotFound(w, r)
		}
	})

	srv := httptest.NewServer(handler)
	defer srv.Close()

	client := &HTTPFilenClient{
		BaseURL:    srv.URL,
		HTTPClient: srv.Client(),
	}

	// Case 1: 正常直接登录 (无 2FA)
	apiKey, req2FA, err := client.Login(ctx, "alice@filen.io", "password123", "")
	if err != nil {
		t.Fatalf("正常登录失败: %v", err)
	}
	if req2FA {
		t.Fatal("不应要求 2FA")
	}
	if apiKey != "mock_filen_api_key_xyz_789" {
		t.Fatalf("期望获得 API Key, 实际: %s", apiKey)
	}

	// Case 2: 触发 2FA 流程
	apiKey, req2FA, err = client.Login(ctx, "twofa@filen.io", "password123", "")
	if err != nil {
		t.Fatalf("触发 2FA 不应报错: %v", err)
	}
	if !req2FA {
		t.Fatal("应该标记 requires2FA=true")
	}
	if apiKey != "" {
		t.Fatalf("未提供 2FA 码时不应返回 key: %s", apiKey)
	}

	// Case 3: 补充 2FA 码后成功获得 API Key
	apiKey, req2FA, err = client.Login(ctx, "twofa@filen.io", "password123", "654321")
	if err != nil || req2FA || apiKey != "mock_filen_api_key_xyz_789" {
		t.Fatalf("带 2FA 码登录失败: err=%v, req2fa=%v, apiKey=%s", err, req2FA, apiKey)
	}

	// Case 4: 密码错误
	_, _, err = client.Login(ctx, "wrongpass@filen.io", "bad", "")
	if err == nil {
		t.Fatal("密码错误应该报错")
	}

	// Case 5: 账号不存在
	_, _, err = client.Login(ctx, "notfound@filen.io", "bad", "")
	if err == nil {
		t.Fatal("账号不存在应该报错")
	}
}
