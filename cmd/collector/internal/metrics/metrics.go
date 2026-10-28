package metrics

import (
	"math"
	"sync"
	"time"
)

// TimingStats 包含时间耗时维度的聚合统计指标。
type TimingStats struct {
	Count   int     `json:"count"`
	Average float64 `json:"average"`
	Max     float64 `json:"max"`
	Min     float64 `json:"min"`
	Total   float64 `json:"total"`
}

// Snapshot 表示当前指标系统的只读快照。
type Snapshot struct {
	Counters map[string]int64       `json:"counters"`
	Gauges   map[string]float64     `json:"gauges"`
	Timings  map[string]TimingStats `json:"timings"`
}

// Service 收集并聚合运行时关键指标。
type Service struct {
	mu       sync.RWMutex
	counters map[string]int64
	gauges   map[string]float64
	timings  map[string][]float64
}

// NewService 创建指标收集服务实例。
func NewService() *Service {
	return &Service{
		counters: make(map[string]int64),
		gauges:   make(map[string]float64),
		timings:  make(map[string][]float64),
	}
}

var defaultService = NewService()

// Default 获取全局默认指标服务。
func Default() *Service {
	return defaultService
}

// Increment 递增计数器。
func (s *Service) Increment(name string, delta ...int64) {
	d := int64(1)
	if len(delta) > 0 {
		d = delta[0]
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.counters[name] += d
}

// Gauge 设置当前仪表盘测量值。
func (s *Service) Gauge(name string, value float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gauges[name] = value
}

// MaxTimingSamples 限制单个度量项最大保留的采样数，防止长期运行内存膨胀。
const MaxTimingSamples = 1000

// Timing 记录一次执行耗时（毫秒）。
func (s *Service) Timing(name string, durationMs float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.timings[name]
	if len(list) >= MaxTimingSamples {
		half := MaxTimingSamples / 2
		copy(list, list[len(list)-half:])
		s.timings[name] = list[:half]
	}
	s.timings[name] = append(s.timings[name], durationMs)
}

// TimingSince 记录从 start 开始到当前的耗时（毫秒）。
func (s *Service) TimingSince(name string, start time.Time) {
	ms := float64(time.Since(start).Nanoseconds()) / 1e6
	s.Timing(name, ms)
}

// GetCounter 读取指定计数器数值。
func (s *Service) GetCounter(name string) int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.counters[name]
}

// GetGauge 读取指定仪表盘数值。
func (s *Service) GetGauge(name string) float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.gauges[name]
}

// GetMetrics 获取包含全部计数器、测量值与耗时聚合的快照。
func (s *Service) GetMetrics() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snap := Snapshot{
		Counters: make(map[string]int64, len(s.counters)),
		Gauges:   make(map[string]float64, len(s.gauges)),
		Timings:  make(map[string]TimingStats, len(s.timings)),
	}

	for k, v := range s.counters {
		snap.Counters[k] = v
	}
	for k, v := range s.gauges {
		snap.Gauges[k] = v
	}
	for k, durations := range s.timings {
		if len(durations) == 0 {
			continue
		}
		var sum float64
		maxVal := durations[0]
		minVal := durations[0]
		for _, d := range durations {
			sum += d
			if d > maxVal {
				maxVal = d
			}
			if d < minVal {
				minVal = d
			}
		}
		avg := sum / float64(len(durations))
		snap.Timings[k] = TimingStats{
			Count:   len(durations),
			Average: math.Round(avg*100) / 100,
			Max:     maxVal,
			Min:     minVal,
			Total:   math.Round(sum*100) / 100,
		}
	}

	return snap
}

// Reset 重置清空所有指标数据。
func (s *Service) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counters = make(map[string]int64)
	s.gauges = make(map[string]float64)
	s.timings = make(map[string][]float64)
}
