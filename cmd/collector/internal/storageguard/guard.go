// Package storageguard 提供磁盘容量预检与看门狗能力。
//
// 在下载 Telegram 文件或外部社媒资源落盘到本地暂存目录（如 /tmp/downloads）前，
// 必须做容量预检：
//  1. 检查目录可写；
//  2. 基于 statfs 读取挂载点可用字节；
//  3. 计算所需空间：预计文件大小 * (1 + 缓冲比例 10%) + 最小保留安全水位 (256MB)；
//  4. 若可用容量不足，提前拦截并返回友好错误，防止容器磁盘写满导致崩溃。
package storageguard

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

const (
	// DefaultRequiredHeadroomRatio 默认保留 10% 缓冲比例。
	DefaultRequiredHeadroomRatio = 0.10
	// DefaultRequiredHeadroomBytes 默认保留 256MB 绝对安全水位。
	DefaultRequiredHeadroomBytes = 256 * 1024 * 1024
)

// InsufficientStorageError 磁盘空间不足错误。
type InsufficientStorageError struct {
	DirPath        string `json:"dirPath"`
	ExpectedBytes  int64  `json:"expectedBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	RequiredBytes  uint64 `json:"requiredBytes"`
	Purpose        string `json:"purpose"`
}

func (e *InsufficientStorageError) Error() string {
	exp := uint64(0)
	if e.ExpectedBytes > 0 {
		exp = uint64(e.ExpectedBytes)
	}
	return fmt.Sprintf("存储空间不足 (%s): 可用 %s, 需保留 %s (预计大小 %s)",
		e.Purpose, FormatBytes(e.AvailableBytes), FormatBytes(e.RequiredBytes), FormatBytes(exp))
}

// Config 存储守卫配置。
type Config struct {
	RequiredHeadroomRatio float64
	RequiredHeadroomBytes uint64
}

// Guard 容量守卫接口与结构体。
type Guard struct {
	cfg    Config
	statfs func(path string) (uint64, error)
}

// New 创建存储容量守卫。
func New(cfg Config) *Guard {
	if cfg.RequiredHeadroomRatio <= 0 {
		cfg.RequiredHeadroomRatio = DefaultRequiredHeadroomRatio
	}
	if cfg.RequiredHeadroomBytes == 0 {
		cfg.RequiredHeadroomBytes = DefaultRequiredHeadroomBytes
	}
	return &Guard{
		cfg:    cfg,
		statfs: statfsAvailableBytes,
	}
}

// SetStatfsFn 用于单元测试注入模拟的 statfs。
func (g *Guard) SetStatfsFn(fn func(path string) (uint64, error)) {
	g.statfs = fn
}

// GetRequiredStorageBytes 计算所需的最小存储字节数。
func (g *Guard) GetRequiredStorageBytes(expectedBytes int64) uint64 {
	ratio := g.cfg.RequiredHeadroomRatio
	if ratio < 0 {
		ratio = 0
	}
	headroom := g.cfg.RequiredHeadroomBytes

	if expectedBytes <= 0 {
		return headroom
	}
	return uint64(math.Ceil(float64(expectedBytes)*(1.0+ratio))) + headroom
}

// AssertCapacity 预检目录容量是否足够。如果不足则返回 InsufficientStorageError。
func (g *Guard) AssertCapacity(dirPath string, expectedBytes int64, purpose string) error {
	if dirPath == "" {
		return errors.New("storageguard: 下载目录未配置")
	}

	absDir, err := filepath.Abs(dirPath)
	if err != nil {
		return fmt.Errorf("storageguard: 解析目录绝对路径失败: %w", err)
	}

	// 确保目录存在且可写
	if err := os.MkdirAll(absDir, 0o755); err != nil {
		return fmt.Errorf("storageguard: 创建下载目录失败: %w", err)
	}

	// 校验写权限
	testFile := filepath.Join(absDir, fmt.Sprintf(".guard_test_%d", os.Getpid()))
	if err := os.WriteFile(testFile, []byte("ok"), 0o600); err != nil {
		return fmt.Errorf("storageguard: 下载目录不可写: %w", err)
	}
	_ = os.Remove(testFile)

	required := g.GetRequiredStorageBytes(expectedBytes)
	available, err := g.statfs(absDir)
	if err != nil {
		return fmt.Errorf("storageguard: 获取可用空间失败: %w", err)
	}

	if available < required {
		return &InsufficientStorageError{
			DirPath:        absDir,
			ExpectedBytes:  expectedBytes,
			AvailableBytes: available,
			RequiredBytes:  required,
			Purpose:        purpose,
		}
	}

	return nil
}

// AvailableBytes 查询指定路径挂载点的可用字节数。
func (g *Guard) AvailableBytes(dirPath string) (uint64, error) {
	return g.statfs(dirPath)
}

// FormatBytes 格式化字节大小为人类可读格式。
func FormatBytes(bytes uint64) string {
	const (
		kb = 1024
		mb = 1024 * kb
		gb = 1024 * mb
		tb = 1024 * gb
	)
	switch {
	case bytes >= tb:
		return fmt.Sprintf("%.2f TB", float64(bytes)/float64(tb))
	case bytes >= gb:
		return fmt.Sprintf("%.2f GB", float64(bytes)/float64(gb))
	case bytes >= mb:
		return fmt.Sprintf("%.2f MB", float64(bytes)/float64(mb))
	case bytes >= kb:
		return fmt.Sprintf("%.2f KB", float64(bytes)/float64(kb))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}
