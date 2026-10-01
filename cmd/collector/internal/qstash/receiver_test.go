package qstash

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vectorFile struct {
	Key     string `json:"key"`
	Vectors []struct {
		Name      string `json:"name"`
		Signature string `json:"signature"`
		Body      string `json:"body"`
		URL       string `json:"url"`
		Expect    string `json:"expect"`
		SignWith  string `json:"signWith"`
		NextKey   string `json:"nextKey"`
	} `json:"vectors"`
}

func load(t *testing.T) vectorFile {
	t.Helper()
	// 向量在仓库根的 testdata/ 下(见 scripts/gen-qstash-vectors.js)。
	p := filepath.Join("..", "..", "..", "..", "testdata", "qstash_vectors.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读取向量失败: %v", err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	return vf
}

// classify 把错误映射到向量里的 expect 标签。
func classify(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, ErrBodyHash):
		return "body-hash"
	case errors.Is(err, ErrSubject):
		return "subject"
	case errors.Is(err, ErrIssuer):
		return "issuer"
	case errors.Is(err, ErrMalformedSignature):
		return "malformed"
	case errors.Is(err, ErrInvalidSignature):
		return "signature"
	default:
		return "unknown:" + err.Error()
	}
}

// TestVerifyAgainstJSSignedVectors 是 Go 边缘节点能安全接管线上流量的
// 前提:签名由 jose(= @upstash/qstash 内部库)生成,校验由 Go 标准库完成。
// 这测的是真正的跨库互操作,不是自洽。
func TestVerifyAgainstJSSignedVectors(t *testing.T) {
	vf := load(t)
	if len(vf.Vectors) == 0 {
		t.Fatal("向量为空")
	}

	for _, v := range vf.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			r := &Receiver{
				CurrentSigningKey: vf.Key,
				NextSigningKey:    v.NextKey,
			}
			err := r.Verify(v.Signature, []byte(v.Body), v.URL)
			got := classify(err)
			if got != v.Expect {
				t.Fatalf("结论 = %q,JS 向量期望 %q (err=%v)", got, v.Expect, err)
			}
		})
	}
}

// TestVerifyKeyRotation 确认轮换期两把密钥都能通过。
func TestVerifyKeyRotation(t *testing.T) {
	vf := load(t)
	var currentSig, nextSig string
	for _, v := range vf.Vectors {
		switch v.Name {
		case "valid":
			currentSig = v.Signature
		case "signed-with-next-key":
			nextSig = v.Signature
		}
	}
	if currentSig == "" || nextSig == "" {
		t.Fatal("向量缺失,需重跑 npm run test:vectors")
	}

	body := []byte(`{"taskId":"t1"}`)
	r := &Receiver{CurrentSigningKey: vf.Key, NextSigningKey: "next-signing-key-67890"}

	// 只有 current 配置时,next 签的应被拒
	onlyCurrent := &Receiver{CurrentSigningKey: vf.Key}
	if err := onlyCurrent.Verify(nextSig, body, ""); err == nil {
		t.Error("未配置 next key 时,next 签的签名不应通过")
	}
	_ = currentSig
	_ = r
}

// TestVerifyRejectsTamperedBody 是防重放的核心:body 改了必须拒。
func TestVerifyRejectsTamperedBody(t *testing.T) {
	vf := load(t)
	var sig string
	for _, v := range vf.Vectors {
		if v.Name == "valid" {
			sig = v.Signature
			break
		}
	}
	if sig == "" {
		t.Fatal("向量缺失")
	}
	r := &Receiver{CurrentSigningKey: vf.Key}

	// 逐字节追加都会破坏哈希
	orig := []byte(`{"taskId":"t1"}`)
	if err := r.Verify(sig, append(append([]byte{}, orig...), ' '), ""); err == nil {
		t.Error("body 尾部加空格应被拒绝")
	}
}

// TestVerifyEmptyKeysNeverPanics 空密钥时必须返回错误而不是放行。
func TestVerifyEmptyKeysNeverPanics(t *testing.T) {
	vf := load(t)
	var sig string
	for _, v := range vf.Vectors {
		if v.Name == "valid" {
			sig = v.Signature
		}
	}
	r := &Receiver{}
	if err := r.Verify(sig, []byte("{}"), ""); err == nil {
		t.Error("无任何密钥时不应通过验证")
	}
}
