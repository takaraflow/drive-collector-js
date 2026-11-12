package shortshare

import (
	"context"
	"errors"
)

var (
	// ErrNotFound 表示短链资源不存在或已失效/已过期。
	ErrNotFound = errors.New("shortshare: 资源不存在或已过期失效")

	// ErrPasswordRequired 表示资源设有访问密码保护，且自动尝试默认日期密码未能解密。
	ErrPasswordRequired = errors.New("shortshare: 该资源设有访问密码")

	// ErrPasswordWrong 表示提交的访问密码错误。
	ErrPasswordWrong = errors.New("shortshare: 访问密码错误")

	// ErrNoMedia 表示页面中未提取到有效的视频或图片媒体资源。
	ErrNoMedia = errors.New("shortshare: 未在页面中发现可转存的媒体资源")

	// ErrAntiBotBlocked 表示遭遇 Cloudflare 或 WAF 反爬拦截。
	ErrAntiBotBlocked = errors.New("shortshare: 遭遇目标站点反爬拦截，暂无法自动抓取")
)

// MediaItem 表示从短链页面中提取出的单个媒体文件。
type MediaItem struct {
	URL         string            `json:"url"`
	FileName    string            `json:"file_name"`
	ContentType string            `json:"content_type"`
	FileSize    int64             `json:"file_size,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
}

// ExtractResult 包含短链解析出的元数据及全部媒体资源。
type ExtractResult struct {
	OriginalURL  string      `json:"original_url"`
	Domain       string      `json:"domain"`
	CodeID       string      `json:"code_id"`
	Title        string      `json:"title"`
	UploadDate   string      `json:"upload_date,omitempty"` // MMDD
	PasswordUsed string      `json:"password_used,omitempty"`
	Items        []MediaItem `json:"items"`
}

// Extractor 定义短链资源提取接口。
type Extractor interface {
	Extract(ctx context.Context, rawURL string, password string) (*ExtractResult, error)
}
