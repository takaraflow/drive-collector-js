package drive

import (
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/pbkdf2"
)

// FilenClient 定义与 Filen 认证网关交互的客户端接口。
type FilenClient interface {
	// Login 执行完整的端到端登录，获取 API Key。
	// 若需要 2FA 动态码且未提供，返回 requires2FA=true。
	Login(ctx context.Context, email, password, twoFactorCode string) (apiKey string, requires2FA bool, err error)
}

// HTTPFilenClient 是 FilenClient 的 HTTP 默认实现。
type HTTPFilenClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

// NewHTTPFilenClient 创建指向 Filen 官方网关的客户端。
func NewHTTPFilenClient() *HTTPFilenClient {
	return &HTTPFilenClient{
		BaseURL: "https://gateway.filen.io",
		HTTPClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

type filenAuthInfoResp struct {
	Status  bool   `json:"status"`
	Message string `json:"message"`
	Code    string `json:"code"`
	Data    struct {
		Salt        string `json:"salt"`
		AuthVersion int    `json:"authVersion"`
	} `json:"data"`
}

type filenLoginResp struct {
	Status  bool   `json:"status"`
	Message string `json:"message"`
	Code    string `json:"code"`
	Data    struct {
		APIKey string `json:"apiKey"`
	} `json:"data"`
}

// DeriveFilenPassword 计算 Filen 客户端端到端派生密码哈希：
// 1. PBKDF2(HMAC-SHA512, iterations=200000, keyLen=64 bytes)
// 2. 将派生结果编码为 128 位十六进制字符串
//    - 前 64 位为 Master Key（客户端端到端加解密密钥，留在本地）
//    - 后 64 位为中间认证密钥（用于提交认证）
// 3. 对中间认证密钥（后 64 位）进行 SHA512 计算，得到最终 API 密码 hex
func DeriveFilenPassword(password, salt string) string {
	derived := pbkdf2.Key([]byte(password), []byte(salt), 200000, 64, sha512.New)
	derivedHex := hex.EncodeToString(derived)
	if len(derivedHex) < 128 {
		return ""
	}
	interKey := derivedHex[64:]
	finalSum := sha512.Sum512([]byte(interKey))
	return hex.EncodeToString(finalSum[:])
}

// Login 实现方案 1：后端代理自动置换 API Key。
func (c *HTTPFilenClient) Login(ctx context.Context, email, password, twoFactorCode string) (string, bool, error) {
	email = strings.TrimSpace(email)
	baseURL := strings.TrimRight(c.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://gateway.filen.io"
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}

	// 1. 获取 Auth Salt
	infoReqBody, _ := json.Marshal(map[string]string{"email": email})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v3/auth/info", bytes.NewReader(infoReqBody))
	if err != nil {
		return "", false, fmt.Errorf("创建 auth info 请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("请求 Filen auth info 失败: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false, fmt.Errorf("读取 Filen auth info 响应失败: %w", err)
	}

	var infoResp filenAuthInfoResp
	if err := json.Unmarshal(bodyBytes, &infoResp); err != nil {
		return "", false, fmt.Errorf("解析 Filen auth info 响应失败: %w", err)
	}
	if !infoResp.Status || infoResp.Data.Salt == "" {
		errMsg := infoResp.Message
		if errMsg == "" {
			errMsg = "账号不存在或服务不可用"
		}
		return "", false, errors.New(errMsg)
	}

	// 2. 派生密码
	derivedPassword := DeriveFilenPassword(password, infoResp.Data.Salt)

	// 3. 提交登录
	code := "XXXXXX"
	if strings.TrimSpace(twoFactorCode) != "" {
		code = strings.TrimSpace(twoFactorCode)
	}

	authVer := infoResp.Data.AuthVersion
	if authVer == 0 {
		authVer = 2
	}

	loginPayload := map[string]any{
		"email":         email,
		"password":      derivedPassword,
		"twoFactorCode": code,
		"authVersion":   authVer,
	}
	loginBytes, _ := json.Marshal(loginPayload)
	loginReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v3/login", bytes.NewReader(loginBytes))
	if err != nil {
		return "", false, fmt.Errorf("创建 login 请求失败: %w", err)
	}
	loginReq.Header.Set("Content-Type", "application/json")
	loginReq.Header.Set("Accept", "application/json")

	loginHTTPResp, err := httpClient.Do(loginReq)
	if err != nil {
		return "", false, fmt.Errorf("请求 Filen login 失败: %w", err)
	}
	defer loginHTTPResp.Body.Close()

	loginBodyBytes, err := io.ReadAll(loginHTTPResp.Body)
	if err != nil {
		return "", false, fmt.Errorf("读取 Filen login 响应失败: %w", err)
	}

	var lResp filenLoginResp
	if err := json.Unmarshal(loginBodyBytes, &lResp); err != nil {
		return "", false, fmt.Errorf("解析 Filen login 响应失败: %w", err)
	}

	if !lResp.Status {
		upperMsg := strings.ToUpper(lResp.Message + " " + lResp.Code)
		if strings.Contains(upperMsg, "2FA") || strings.Contains(upperMsg, "TWO_FACTOR") || strings.Contains(upperMsg, "ENTER_2FA") {
			return "", true, nil
		}
		errMsg := lResp.Message
		if errMsg == "" {
			errMsg = "密码错误或登录失败"
		}
		return "", false, errors.New(errMsg)
	}

	if lResp.Data.APIKey == "" {
		return "", false, errors.New("登录成功但未返回有效 API Key")
	}

	return lResp.Data.APIKey, false, nil
}
