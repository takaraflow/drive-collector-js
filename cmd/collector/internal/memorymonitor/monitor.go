package memorymonitor

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	BytesPerMB                    = 1024 * 1024
	DefaultWarningRatio           = 0.75
	DefaultCriticalRatio          = 0.90
	MaxReasonableMemoryLimitBytes = int64(1) << 40 // 1TB，过滤宿主机 sentinel
)

// Config 内存监控配置。
type Config struct {
	WarningRatio  float64
	CriticalRatio float64
	Interval      time.Duration
	Log           *slog.Logger
	CustomLimit   int64 // 显式指定的内存上限字节（若为 0 则尝试从 cgroup 读取）
}

// Diagnostics 包含格式化与原始内存统计。
type Diagnostics struct {
	AllocMB        string `json:"allocMb"`
	TotalAllocMB   string `json:"totalAllocMb"`
	SysMB          string `json:"sysMb"`
	NumGC          uint32 `json:"numGc"`
	ContainerLimit string `json:"containerLimit"`
	PressureRatio  string `json:"pressureRatio"`
	IsCritical     bool   `json:"isCritical"`
}

// Monitor 内存监控守护器。
type Monitor struct {
	cfg Config
	mu  sync.RWMutex
}

// NewMonitor 创建内存监控器。
func NewMonitor(cfg Config) *Monitor {
	if cfg.WarningRatio <= 0 {
		cfg.WarningRatio = DefaultWarningRatio
	}
	if cfg.CriticalRatio <= 0 {
		cfg.CriticalRatio = DefaultCriticalRatio
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Monitor{cfg: cfg}
}

// ReadContainerMemoryLimitBytes 读取容器 cgroup 内存限额。
func ReadContainerMemoryLimitBytes() int64 {
	paths := []string{
		"/sys/fs/cgroup/memory.max",
		"/sys/fs/cgroup/memory/memory.limit_in_bytes",
	}

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if limit := ParseCgroupLimit(string(data)); limit > 0 {
			return limit
		}
	}
	return 0
}

// ParseCgroupLimit 解析 cgroup 内存文件内容，过滤非法字符、max 以及假上限。
func ParseCgroupLimit(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "max" {
		return 0
	}
	limit, err := strconv.ParseInt(raw, 10, 64)
	if err == nil && limit > 0 && limit < MaxReasonableMemoryLimitBytes {
		return limit
	}
	return 0
}

// CheckPressure 检查当前内存压力，在达到严重水位时主动 GC 并归还 OS 内存。
func (m *Monitor) CheckPressure() Diagnostics {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	limit := m.cfg.CustomLimit
	if limit <= 0 {
		limit = ReadContainerMemoryLimitBytes()
	}

	diag := Diagnostics{
		AllocMB:      fmt.Sprintf("%.1fMB", float64(ms.Alloc)/BytesPerMB),
		TotalAllocMB: fmt.Sprintf("%.1fMB", float64(ms.TotalAlloc)/BytesPerMB),
		SysMB:        fmt.Sprintf("%.1fMB", float64(ms.Sys)/BytesPerMB),
		NumGC:        ms.NumGC,
	}

	if limit > 0 {
		ratio := float64(ms.Alloc) / float64(limit)
		diag.ContainerLimit = fmt.Sprintf("%.1fMB", float64(limit)/BytesPerMB)
		diag.PressureRatio = fmt.Sprintf("%.1f%%", ratio*100)

		if ratio >= m.cfg.CriticalRatio {
			diag.IsCritical = true
			m.cfg.Log.Warn("🚨 内存警戒水位超限，触发主动 GC 与内存释放",
				"alloc", diag.AllocMB,
				"limit", diag.ContainerLimit,
				"ratio", diag.PressureRatio)

			runtime.GC()
			debug.FreeOSMemory()

			var afterMS runtime.MemStats
			runtime.ReadMemStats(&afterMS)
			afterRatio := float64(afterMS.Alloc) / float64(limit)
			m.cfg.Log.Info("主动 GC 完成",
				"beforeAlloc", diag.AllocMB,
				"afterAlloc", fmt.Sprintf("%.1fMB", float64(afterMS.Alloc)/BytesPerMB),
				"afterRatio", fmt.Sprintf("%.1f%%", afterRatio*100))
		} else if ratio >= m.cfg.WarningRatio {
			m.cfg.Log.Warn("⚠️ 内存较高，请注意负载",
				"alloc", diag.AllocMB,
				"limit", diag.ContainerLimit,
				"ratio", diag.PressureRatio)
		}
	} else {
		diag.ContainerLimit = "unlimited"
		diag.PressureRatio = "N/A"
	}

	return diag
}

// Start 启动后台周期监控巡检。
func (m *Monitor) Start(ctx context.Context) {
	ticker := time.NewTicker(m.cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.CheckPressure()
		}
	}
}
