package edge

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// signFor 构造一个 QStash 风格的 HS256 签名。
// 与 scripts/gen-qstash-vectors.js 用的是同一套规则,这样测试里的
// 请求和线上向量是同一种签名,不会出现「测试通过但线上不认」。
func signFor(r *http.Request, body []byte, key string) (string, error) {
	sum := sha256.Sum256(body)
	bodyHash := base64.RawURLEncoding.EncodeToString(sum[:])

	claims, err := json.Marshal(map[string]any{
		"sub":  fullURL(r),
		"body": bodyHash,
		"iss":  "Upstash",
		"iat":  time.Now().Unix(),
	})
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	payload := base64.RawURLEncoding.EncodeToString(claims)
	signing := header + "." + payload

	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(signing))
	return signing + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// discardLogger 静默 logger,避免测试输出噪音。
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// 确保签名辅助函数签名与 http.Request 一致,防止调用方误用。
var _ = fmt.Sprintf