package memorymonitor

import (
	"context"
	"testing"
)

func TestMemoryMonitor_CheckPressure(t *testing.T) {
	// 模拟设定较小的内存上限，触发 warning 或 critical
	cfg := Config{
		WarningRatio:  0.50,
		CriticalRatio: 0.80,
		CustomLimit:   50 * BytesPerMB, // 50MB
	}
	m := NewMonitor(cfg)

	diag := m.CheckPressure()
	if diag.AllocMB == "" {
		t.Fatalf("expected non-empty AllocMB")
	}
	if diag.ContainerLimit != "50.0MB" {
		t.Fatalf("expected 50.0MB container limit, got %s", diag.ContainerLimit)
	}

	// 极低限额触发 Critical
	cfgCritical := Config{
		WarningRatio:  0.01,
		CriticalRatio: 0.02,
		CustomLimit:   1024, // 1KB
	}
	mCritical := NewMonitor(cfgCritical)
	diagCrit := mCritical.CheckPressure()
	if !diagCrit.IsCritical {
		t.Fatalf("expected critical pressure flag to be true")
	}

	// 测试 Start 生命周期退出
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m.Start(ctx) // 应立即返回
}

func TestParseCgroupLimit_EdgeCases(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want int64
	}{
		{"empty string", "", 0},
		{"whitespace only", "   \n", 0},
		{"cgroup v2 max", "max\n", 0},
		{"non numeric text", "unlimited", 0},
		{"negative value", "-1", 0},
		{"zero value", "0", 0},
		{"exceeds reasonable limit (sentinel)", "9223372036854771712", 0},
		{"valid 512MB", "536870912\n", 536870912},
		{"valid 1GB", "1073741824", 1073741824},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseCgroupLimit(tt.raw)
			if got != tt.want {
				t.Errorf("ParseCgroupLimit(%q) = %d, want %d", tt.raw, got, tt.want)
			}
		})
	}
}
