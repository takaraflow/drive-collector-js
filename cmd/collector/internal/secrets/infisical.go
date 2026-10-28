package secrets

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// InfisicalConfig Infisical 客户端配置。
type InfisicalConfig struct {
	SiteURL      string // 默认 https://app.infisical.com
	Token        string // Service Token 或 Access Token
	ClientID     string // Universal Auth Client ID
	ClientSecret string // Universal Auth Client Secret
	ProjectID    string // 项目 ID
	EnvName      string // 环境名: dev, staging, prod
	SecretPath   string // 密钥路径，默认 "/"
	HTTPClient   *http.Client
}

// InfisicalProvider 从 Infisical 统一获取密钥。
type InfisicalProvider struct {
	cfg         InfisicalConfig
	client      *http.Client
	accessToken string
	mu          sync.Mutex
}

// NewInfisicalProvider 创建 Infisical 密钥提供者。
func NewInfisicalProvider(cfg InfisicalConfig) *InfisicalProvider {
	site := cfg.SiteURL
	if site == "" {
		site = os.Getenv("INFISICAL_SITE_URL")
		if site == "" {
			site = "https://app.infisical.com"
		}
	}
	site = strings.TrimRight(site, "/")

	token := cfg.Token
	if token == "" {
		token = os.Getenv("INFISICAL_TOKEN")
	}

	clientID := cfg.ClientID
	if clientID == "" {
		clientID = os.Getenv("INFISICAL_CLIENT_ID")
	}

	clientSecret := cfg.ClientSecret
	if clientSecret == "" {
		clientSecret = os.Getenv("INFISICAL_CLIENT_SECRET")
	}

	projectID := cfg.ProjectID
	if projectID == "" {
		projectID = os.Getenv("INFISICAL_PROJECT_ID")
	}

	envName := cfg.EnvName
	if envName == "" {
		envName = os.Getenv("INFISICAL_ENV")
		if envName == "" {
			envName = "prod"
		}
	}

	secretPath := cfg.SecretPath
	if secretPath == "" {
		secretPath = os.Getenv("INFISICAL_SECRET_PATH")
		if secretPath == "" {
			secretPath = "/"
		}
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}

	return &InfisicalProvider{
		cfg: InfisicalConfig{
			SiteURL:      site,
			Token:        token,
			ClientID:     clientID,
			ClientSecret: clientSecret,
			ProjectID:    projectID,
			EnvName:      envName,
			SecretPath:   secretPath,
		},
		client:      client,
		accessToken: token,
	}
}

type universalAuthResponse struct {
	AccessToken string `json:"accessToken"`
	ExpiresIn   int    `json:"expiresIn"`
}

type infisicalSecretItem struct {
	SecretKey   string `json:"secretKey"`
	SecretValue string `json:"secretValue"`
}

type listSecretsResponse struct {
	Secrets []infisicalSecretItem `json:"secrets"`
}

// Authenticate 通过 Service Token 或 Universal Auth 获取 Access Token。
func (p *InfisicalProvider) Authenticate(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.accessToken != "" {
		return nil
	}

	if p.cfg.ClientID == "" || p.cfg.ClientSecret == "" {
		return fmt.Errorf("infisical: 缺少认证凭据 (需要 token 或 clientId/clientSecret)")
	}

	loginURL := fmt.Sprintf("%s/api/v1/auth/universal-auth/login", p.cfg.SiteURL)
	loginBody, _ := json.Marshal(map[string]string{
		"clientId":     p.cfg.ClientID,
		"clientSecret": p.cfg.ClientSecret,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginURL, bytes.NewReader(loginBody))
	if err != nil {
		return fmt.Errorf("infisical: build login request failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("infisical: login failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("infisical: login status %d: %s", resp.StatusCode, string(b))
	}

	var authResp universalAuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		return fmt.Errorf("infisical: parse login response failed: %w", err)
	}

	p.accessToken = authResp.AccessToken
	return nil
}

// FetchSecrets 获取项目下的所有密钥键值对。
func (p *InfisicalProvider) FetchSecrets(ctx context.Context) (map[string]string, error) {
	if err := p.Authenticate(ctx); err != nil {
		return nil, err
	}

	if p.cfg.ProjectID == "" {
		return nil, fmt.Errorf("infisical: 缺少 ProjectID")
	}

	q := url.Values{}
	q.Set("workspaceId", p.cfg.ProjectID)
	q.Set("environment", p.cfg.EnvName)
	q.Set("secretPath", p.cfg.SecretPath)
	q.Set("include_imports", "true")

	fetchURL := fmt.Sprintf("%s/api/v3/secrets/raw?%s", p.cfg.SiteURL, q.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fetchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("infisical: build request failed: %w", err)
	}

	p.mu.Lock()
	token := p.accessToken
	p.mu.Unlock()

	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("infisical: fetch secrets request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("infisical: fetch secrets status %d: %s", resp.StatusCode, string(b))
	}

	var listResp listSecretsResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("infisical: parse secrets response failed: %w", err)
	}

	result := make(map[string]string, len(listResp.Secrets))
	for _, s := range listResp.Secrets {
		result[s.SecretKey] = s.SecretValue
	}
	return result, nil
}
