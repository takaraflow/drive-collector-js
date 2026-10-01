// Package d1 是 Cloudflare D1 的 Go 客户端。
//
// 为什么不用 SQLite 驱动:D1 不是本地 SQLite 文件,是 Cloudflare 的
// HTTP REST 接口。所有 SQL 走 POST 打到
// https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query
//
// 表结构是纯 TEXT/INTEGER(见 src/database/schema.js),没有任何 JSON 列
// 或自定义类型,所以 Go 侧零格式转换成本 —— 直接把 JS 的行结构映射过来。
//
// 重试语义与 JS 侧 d1.js 对齐:网络错误和 5xx 重试,4xx 不重试。
// D1 的 SQL 错误是 4xx(比如约束冲突),重试没有意义。
package d1

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Config 是 D1 客户端配置。
type Config struct {
	AccountID  string
	DatabaseID string
	Token      string
	BaseURL    string // 为空时用 Cloudflare 官方端点;测试可注入
	Log        *slog.Logger
	HTTPClient *http.Client
	// MaxAttempts 对齐 JS 侧的 3 次。
	MaxAttempts int
}

// Client 是 D1 客户端。
type Client struct {
	cfg  Config
	http *http.Client
}

// New 构造客户端。此时不发起任何请求。
func New(cfg Config) (*Client, error) {
	if cfg.AccountID == "" || cfg.DatabaseID == "" || cfg.Token == "" {
		return nil, fmt.Errorf("d1: 配置不完整(需要 AccountID / DatabaseID / Token)")
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.MaxAttempts == 0 {
		cfg.MaxAttempts = 3
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.cloudflare.com/client/v4"
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{cfg: cfg, http: hc}, nil
}

// endpoint 拼出 REST 路径 —— 与 JS 侧 d1.js 的 apiUrl 逐字一致。
func (c *Client) endpoint() string {
	return fmt.Sprintf("%s/accounts/%s/d1/database/%s/query",
		c.cfg.BaseURL, c.cfg.AccountID, c.cfg.DatabaseID)
}

// payload 是 Cloudflare 期望的请求体。
type payload struct {
	SQL    string        `json:"sql"`
	Params []interface{} `json:"params"`
}

// response 是 Cloudflare 的响应外壳。
type response struct {
	Success bool              `json:"success"`
	Errors  []cloudflareError `json:"errors"`
	Result  []queryResult     `json:"result"`
}

type cloudflareError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type queryResult struct {
	Success bool                   `json:"success"`
	Results []map[string]interface{} `json:"results"`
	Meta    struct {
		RowsRead    int `json:"rows_read"`
		RowsWritten int `json:"rows_written"`
	} `json:"meta"`
}

// Execute 跑一条 SQL,返回结果行。
func (c *Client) Execute(ctx context.Context, sql string, params ...interface{}) ([]map[string]interface{}, error) {
	if params == nil {
		params = []interface{}{}
	}

	body, err := json.Marshal(payload{SQL: sql, Params: params})
	if err != nil {
		return nil, fmt.Errorf("d1: 编码请求失败: %w", err)
	}

	resp, err := c.do(ctx, body)
	if err != nil {
		return nil, err
	}

	var decoded response
	if err := json.Unmarshal(resp, &decoded); err != nil {
		return nil, fmt.Errorf("d1: 解析响应失败: %w", err)
	}
	if !decoded.Success {
		return nil, fmt.Errorf("d1: 查询失败: %s", formatErrors(decoded.Errors))
	}

	if len(decoded.Result) == 0 {
		return nil, nil
	}
	if !decoded.Result[0].Success {
		return nil, fmt.Errorf("d1: SQL 执行失败")
	}
	return decoded.Result[0].Results, nil
}

// FetchAll 取全部行 —— 对应 JS 侧 d1.fetchAll。
func (c *Client) FetchAll(ctx context.Context, sql string, params ...interface{}) ([]map[string]interface{}, error) {
	return c.Execute(ctx, sql, params...)
}

// FetchOne 取第一行,没有则返回 nil —— 对应 JS 侧 d1.fetchOne。
//
// 刻意不返回 error:「查不到」是正常业务分支,不是异常。
func (c *Client) FetchOne(ctx context.Context, sql string, params ...interface{}) (map[string]interface{}, error) {
	rows, err := c.Execute(ctx, sql, params...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// Exec 跑写语句(INSERT/UPDATE/DELETE),返回受影响行数。
func (c *Client) Exec(ctx context.Context, sql string, params ...interface{}) (int64, error) {
	body, err := json.Marshal(payload{SQL: sql, Params: paramsOrEmpty(params)})
	if err != nil {
		return 0, fmt.Errorf("d1: 编码请求失败: %w", err)
	}
	resp, err := c.do(ctx, body)
	if err != nil {
		return 0, err
	}
	var decoded response
	if err := json.Unmarshal(resp, &decoded); err != nil {
		return 0, fmt.Errorf("d1: 解析响应失败: %w", err)
	}
	if !decoded.Success {
		return 0, fmt.Errorf("d1: 执行失败: %s", formatErrors(decoded.Errors))
	}
	if len(decoded.Result) == 0 {
		return 0, nil
	}
	return int64(decoded.Result[0].Meta.RowsWritten), nil
}

func paramsOrEmpty(p []interface{}) []interface{} {
	if p == nil {
		return []interface{}{}
	}
	return p
}

// do 发请求并按「网络错误 / 5xx 重试,4xx 不重试」的规则处理。
func (c *Client) do(ctx context.Context, body []byte) ([]byte, error) {
	var lastErr error

	for attempt := 1; attempt <= c.cfg.MaxAttempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("d1: 构造请求失败: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.cfg.Token)

		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("d1: 请求失败(第 %d/%d 次): %w", attempt, c.cfg.MaxAttempts, err)
			c.cfg.Log.Warn("d1 network error", "attempt", attempt, "err", err)
			continue
		}

		raw, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("d1: 读取响应失败: %w", readErr)
			continue
		}

		if resp.StatusCode >= 500 {
			// Cloudflare 侧临时故障,重试有意义。
			lastErr = fmt.Errorf("d1: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
			c.cfg.Log.Warn("d1 server error", "attempt", attempt, "status", resp.StatusCode)
			continue
		}
		if resp.StatusCode >= 400 {
			// 4xx 是 SQL 错误或认证失败,重试只会浪费时间。
			return nil, fmt.Errorf("d1: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
		}
		return raw, nil
	}

	return nil, fmt.Errorf("d1: %d 次重试后仍失败: %w", c.cfg.MaxAttempts, lastErr)
}

func formatErrors(errs []cloudflareError) string {
	if len(errs) == 0 {
		return "(无错误详情)"
	}
	parts := make([]string, 0, len(errs))
	for _, e := range errs {
		parts = append(parts, fmt.Sprintf("[%d] %s", e.Code, e.Message))
	}
	return strings.Join(parts, "; ")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}