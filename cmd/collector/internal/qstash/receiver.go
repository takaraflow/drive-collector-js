// Package qstash 复刻 @upstash/qstash Receiver.verify()。
//
// 签名方案:HS256 JWT,issuer 固定 "Upstash",claims 为 {sub, body}。
// body 是 base64url(SHA256(原始 body))。校验顺序与上游一致:
// HMAC → issuer → sub 与请求 URL 相等 → body 哈希相等。
//
// 刻意不引入 JWT 库:整条链路只需要 HMAC-SHA256 加一次 JSON 解码,
// 标准库已经够用,少一个依赖少一处升级面。
package qstash

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var (
	ErrMalformedSignature = errors.New("qstash: malformed signature")
	ErrInvalidSignature   = errors.New("qstash: signature does not match")
	ErrIssuer             = errors.New("qstash: unexpected issuer")
	ErrSubject            = errors.New("qstash: subject does not match request url")
	ErrBodyHash           = errors.New("qstash: body hash does not match")
)

const expectedIssuer = "Upstash"

// payload 对应上游签名里的 claims 子集。
type payload struct {
	Sub  string `json:"sub"`
	Body string `json:"body"`
	Iss  string `json:"iss"`
}

// Receiver 持有当前/下一把签名密钥。上游先试 current 再试 next,
// 这样密钥轮换期间新旧签名都能通过。
type Receiver struct {
	CurrentSigningKey string
	NextSigningKey    string
}

// Verify 校验 QStash 签名。url 传请求的完整 URL(含 query),body 传原始字节。
// body 必须逐字节与签名时一致 —— 任何 JSON 重序列化都会导致哈希不匹配。
func (r *Receiver) Verify(signature string, body []byte, url string) error {
	keys := []string{r.CurrentSigningKey}
	if r.NextSigningKey != "" && r.NextSigningKey != r.CurrentSigningKey {
		keys = append(keys, r.NextSigningKey)
	}

	var lastErr error
	for _, key := range keys {
		if key == "" {
			continue
		}
		err := verifyWithKey(signature, body, url, key)
		if err == nil {
			return nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = ErrInvalidSignature
	}
	return lastErr
}

func verifyWithKey(signature string, body []byte, url, key string) error {
	parts := strings.Split(signature, ".")
	if len(parts) != 3 {
		return ErrMalformedSignature
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMalformedSignature, err)
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sigBytes, mac.Sum(nil)) {
		return ErrInvalidSignature
	}

	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMalformedSignature, err)
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("%w: %v", ErrMalformedSignature, err)
	}

	if p.Iss != expectedIssuer {
		return fmt.Errorf("%w: got %q", ErrIssuer, p.Iss)
	}
	if url != "" && p.Sub != url {
		return fmt.Errorf("%w: got %q want %q", ErrSubject, p.Sub, url)
	}

	sum := sha256.Sum256(body)
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	// 上游对尾部 "=" 做 trim 后比较,这里照搬,避免 padding 差异误判。
	if trimPadding(p.Body) != trimPadding(want) {
		return ErrBodyHash
	}
	return nil
}

func trimPadding(s string) string {
	return strings.TrimRight(s, "=")
}
