package gofile

import (
	"errors"
	"time"
)

var (
	ErrNotFound         = errors.New("gofile: 资源不存在或已被删除")
	ErrPasswordRequired = errors.New("gofile: 该文件夹设有密码保护")
	ErrRateLimited      = errors.New("gofile: 官方服务繁忙(触发频率限制)，请稍后重试")
	ErrNotPremium       = errors.New("gofile: 访客凭证权限不足")
	ErrWrongToken       = errors.New("gofile: 访客凭证无效或已过期")
	ErrNoMedia          = errors.New("gofile: 文件夹中未发现可转存的文件")
)

// FileItem 表示 Gofile 文件夹中的单个文件信息。
type FileItem struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	MimeType  string    `json:"mimetype"`
	MD5       string    `json:"md5,omitempty"`
	Link      string    `json:"link"`
	Thumbnail string    `json:"thumbnail,omitempty"`
	ModTime   time.Time `json:"mod_time,omitempty"`
}

// FolderResult 包含解析后的文件夹与文件列表信息。
type FolderResult struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	TotalSize   int64      `json:"total_size"`
	ItemCount   int        `json:"item_count"`
	Files       []FileItem `json:"files"`
	AccountToken string    `json:"account_token"`
}
