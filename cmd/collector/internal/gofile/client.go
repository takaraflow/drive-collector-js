package gofile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	defaultTokenFile = "/tmp/gofile_token_cache.json"
	defaultSalt      = "12af056dacea0b"
	defaultTokenTTL  = 12 * time.Hour
)

type Client struct {
	http           *http.Client
	baseURL        string
	userAgent      string
	tokenCacheFile string
	tokenTTL       time.Duration
	salt           string

	mu           sync.Mutex
	tokenCache   string
	tokenCreated time.Time
}

func NewClient() *Client {
	return &Client{
		http: &http.Client{
			Timeout: 15 * time.Second,
		},
		baseURL:        "https://api.gofile.io",
		userAgent:      DefaultUserAgent,
		tokenCacheFile: defaultTokenFile,
		tokenTTL:       defaultTokenTTL,
		salt:           defaultSalt,
	}
}

type cachedTokenData struct {
	Token     string `json:"token"`
	CreatedAt int64  `json:"created_at"`
}

// GetAccountToken 获取或创建 Gofile 访客凭证，内置文件与内存缓存，避免频繁调用触发 429。
func (c *Client) GetAccountToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// 0. 支持环境变量静态配置优先（如用户配置了专属的 GOFILE_TOKEN）
	if envToken := strings.TrimSpace(os.Getenv("GOFILE_TOKEN")); envToken != "" {
		return envToken, nil
	}

	ttl := c.tokenTTL
	if ttl <= 0 {
		ttl = defaultTokenTTL
	}

	if c.tokenCache != "" && (c.tokenCreated.IsZero() || time.Since(c.tokenCreated) < ttl) {
		return c.tokenCache, nil
	}

	// 1. 尝试从本地持久化缓存文件读取
	if c.tokenCacheFile != "" {
		if data, err := os.ReadFile(c.tokenCacheFile); err == nil {
			var cached cachedTokenData
			if err := json.Unmarshal(data, &cached); err == nil && cached.Token != "" {
				// 检查缓存有效时长，未设置创建时间或超过 TTL 均视为失效
				if cached.CreatedAt > 0 && time.Since(time.Unix(cached.CreatedAt, 0)) < ttl {
					c.tokenCache = cached.Token
					c.tokenCreated = time.Unix(cached.CreatedAt, 0)
					return c.tokenCache, nil
				}
				// 缓存已过期，主动清除旧文件
				_ = os.Remove(c.tokenCacheFile)
			}
		}
	}

	// 2. 缓存不存在或已过期，调用 API 创建新访客账号
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.gofile.io"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/accounts", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("gofile: 创建访客账号网络错误: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		return "", ErrRateLimited
	}

	var res struct {
		Status string `json:"status"`
		Data   struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return "", fmt.Errorf("gofile: 解析访客账号响应失败: %w", err)
	}

	if res.Status == "error-rateLimit" {
		return "", ErrRateLimited
	}
	if res.Status != "ok" || res.Data.Token == "" {
		return "", fmt.Errorf("gofile: 创建访客账号失败: %s", string(body))
	}

	c.tokenCache = res.Data.Token
	c.tokenCreated = time.Now()

	// 保存到本地缓存
	if c.tokenCacheFile != "" {
		_ = os.MkdirAll(filepath.Dir(c.tokenCacheFile), 0755)
		toSave, _ := json.Marshal(cachedTokenData{
			Token:     c.tokenCache,
			CreatedAt: c.tokenCreated.Unix(),
		})
		_ = os.WriteFile(c.tokenCacheFile, toSave, 0644)
	}

	return c.tokenCache, nil
}

// InvalidateToken 清除当前 Token 缓存（当遇到 error-notPremium 或 error-wrongToken 时调用）。
func (c *Client) InvalidateToken() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tokenCache = ""
	c.tokenCreated = time.Time{}
	if c.tokenCacheFile != "" {
		_ = os.Remove(c.tokenCacheFile)
	}
}

// GenerateWebsiteToken 计算官方 wt 签名。
// 优先使用 Node 执行官方前端混淆代码动态生成；如果不可用，降级为纯 Go 原生 SHA256 计算。
func (c *Client) GenerateWebsiteToken(ctx context.Context, token string) string {
	// 尝试通过 Node.js 动态计算（官方脚本自适应）
	if wt, err := c.evalOfficialWTScript(ctx, token); err == nil && wt != "" {
		return wt
	}

	// 降级：Go 本地原生 SHA256 算法
	window := time.Now().Unix() / 14400
	raw := fmt.Sprintf("%s::en-US::%s::%d::%s", c.userAgent, token, window, c.salt)
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}

func (c *Client) evalOfficialWTScript(ctx context.Context, token string) (string, error) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return "", err
	}

	cmdCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	script := fmt.Sprintf(`
import fs from 'node:fs';

const USER_AGENT = %q;
const TOKEN = %q;
const SCRIPT_CACHE = '/tmp/gofile_wt.obf.js';

async function getWTScript() {
  try {
    if (fs.existsSync(SCRIPT_CACHE)) {
      const stat = fs.statSync(SCRIPT_CACHE);
      if (Date.now() - stat.mtimeMs < 4 * 3600 * 1000) {
        return fs.readFileSync(SCRIPT_CACHE, 'utf-8');
      }
    }
  } catch (_) {}

  const res = await fetch("https://gofile.io/js/wt.obf.js", {
    headers: { "User-Agent": USER_AGENT }
  });
  if (!res.ok) throw new Error("fetch failed");
  const code = await res.text();
  try { fs.writeFileSync(SCRIPT_CACHE, code, 'utf-8'); } catch (_) {}
  return code;
}

(async () => {
  try {
    const code = await getWTScript();
    let window = global;
    let document = { location: { href: "https://gofile.io/" } };
    let navigator = { userAgent: USER_AGENT, language: "en-US", languages: ["en-US", "en"] };
    eval(code);
    const wt = generateWT(TOKEN);
    process.stdout.write(wt);
  } catch (e) {
    process.exit(1);
  }
})();
`, c.userAgent, token)

	cmd := exec.CommandContext(cmdCtx, nodePath, "--input-type=module", "-e", script)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	res := strings.TrimSpace(string(out))
	if len(res) == 64 {
		return res, nil
	}
	return "", errors.New("invalid wt output")
}

type apiContentResponse struct {
	Status string                 `json:"status"`
	Data   apiContentData         `json:"data"`
}

type apiContentData struct {
	ID            string                        `json:"id"`
	Type          string                        `json:"type"`
	Name          string                        `json:"name"`
	TotalSize     int64                         `json:"totalSize"`
	ChildrenCount int                           `json:"childrenCount"`
	Link          string                        `json:"link"`
	Mimetype      string                        `json:"mimetype"`
	Md5           string                        `json:"md5"`
	Children      map[string]apiContentChildItem `json:"children"`
}

type apiContentChildItem struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Mimetype  string `json:"mimetype"`
	Link      string `json:"link"`
	Md5       string `json:"md5"`
	Thumbnail string `json:"thumbnail"`
}

// Resolve 解析 Gofile 内容（支持文件夹或单文件）。
func (c *Client) Resolve(ctx context.Context, contentID, password string) (*FolderResult, error) {
	contentID = strings.TrimSpace(contentID)
	if contentID == "" {
		return nil, errors.New("gofile: contentID 不能为空")
	}

	token, err := c.GetAccountToken(ctx)
	if err != nil {
		return nil, err
	}

	result, err := c.queryContent(ctx, contentID, token, password)
	if errors.Is(err, ErrNotPremium) || errors.Is(err, ErrWrongToken) {
		// 凭证过期或无效，重置缓存并重新获取凭证重试一次
		c.InvalidateToken()
		token, err = c.GetAccountToken(ctx)
		if err != nil {
			return nil, err
		}
		result, err = c.queryContent(ctx, contentID, token, password)
		if errors.Is(err, ErrNotPremium) || errors.Is(err, ErrWrongToken) {
			// 若重试后依然报凭证错误，再次清理缓存避免残留无效凭证
			c.InvalidateToken()
		}
	}

	return result, err
}

func (c *Client) queryContent(ctx context.Context, contentID, token, password string) (*FolderResult, error) {
	wt := c.GenerateWebsiteToken(ctx, token)

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.gofile.io"
	}
	apiURL := fmt.Sprintf("%s/contents/%s?wt=%s", baseURL, contentID, wt)
	if password != "" {
		apiURL += fmt.Sprintf("&password=%s", password)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Website-Token", wt)
	req.Header.Set("X-BL", "en-US")
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Origin", "https://gofile.io")
	req.Header.Set("Referer", "https://gofile.io/")

	resp, err := c.http.Do(req)
	if err != nil {
		if os.IsTimeout(err) || errors.Is(err, context.DeadlineExceeded) {
			return nil, ErrRateLimited
		}
		return nil, fmt.Errorf("gofile: 请求文件夹内容失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, ErrRateLimited
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var res apiContentResponse
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, fmt.Errorf("gofile: 解析内容响应失败: %w", err)
	}

	switch res.Status {
	case "ok":
		// 成功，继续处理
	case "error-rateLimit":
		return nil, ErrRateLimited
	case "error-passwordRequired":
		return nil, ErrPasswordRequired
	case "error-notFound":
		return nil, ErrNotFound
	case "error-notPremium":
		return nil, ErrNotPremium
	case "error-wrongToken":
		return nil, ErrWrongToken
	default:
		return nil, fmt.Errorf("gofile: 接口返回错误: %s", res.Status)
	}

	data := res.Data
	out := &FolderResult{
		ID:           data.ID,
		Name:         data.Name,
		TotalSize:    data.TotalSize,
		AccountToken: token,
	}

	// 1. 如果本身就是单文件
	if data.Type == "file" {
		out.ItemCount = 1
		out.Files = []FileItem{
			{
				ID:       data.ID,
				Name:     data.Name,
				Size:     data.TotalSize,
				MimeType: data.Mimetype,
				MD5:      data.Md5,
				Link:     data.Link,
			},
		}
		return out, nil
	}

	// 2. 如果是文件夹，遍历提取子文件
	var files []FileItem
	for id, item := range data.Children {
		if item.Type == "file" {
			files = append(files, FileItem{
				ID:        id,
				Name:      item.Name,
				Size:      item.Size,
				MimeType:  item.Mimetype,
				Link:      item.Link,
				MD5:       item.Md5,
				Thumbnail: item.Thumbnail,
			})
		}
	}

	if len(files) == 0 {
		return nil, ErrNoMedia
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].Name < files[j].Name
	})

	out.ItemCount = len(files)
	out.Files = files
	return out, nil
}
