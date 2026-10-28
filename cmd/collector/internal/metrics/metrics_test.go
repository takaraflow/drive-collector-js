package metrics

import (
	"testing"
	"time"
)

func TestMetricsService(t *testing.T) {
	s := NewService()

	// Counter
	s.Increment("tasks_total")
	s.Increment("tasks_total", 4)
	if got := s.GetCounter("tasks_total"); got != 5 {
		t.Fatalf("expected tasks_total=5, got %d", got)
	}

	// Gauge
	s.Gauge("cpu_usage", 42.5)
	if got := s.GetGauge("cpu_usage"); got != 42.5 {
		t.Fatalf("expected cpu_usage=42.5, got %f", got)
	}

	// Timing
	s.Timing("download_duration", 100)
	s.Timing("download_duration", 200)
	s.Timing("download_duration", 300)

	start := time.Now().Add(-10 * time.Millisecond)
	s.TimingSince("upload_duration", start)

	metrics := s.GetMetrics()

	timing, ok := metrics.Timings["download_duration"]
	if !ok {
		t.Fatalf("missing download_duration timing")
	}
	if timing.Count != 3 {
		t.Errorf("expected count=3, got %d", timing.Count)
	}
	if timing.Average != 200.0 {
		t.Errorf("expected avg=200, got %f", timing.Average)
	}
	if timing.Min != 100.0 || timing.Max != 300.0 {
		t.Errorf("expected min=100 max=300, got min=%f max=%f", timing.Min, timing.Max)
	}

	// Reset
	s.Reset()
	if len(s.GetMetrics().Counters) != 0 || len(s.GetMetrics().Gauges) != 0 || len(s.GetMetrics().Timings) != 0 {
		t.Fatalf("expected empty metrics after reset")
	}
}

func TestMetricsTimingSampleCapping(t *testing.T) {
	m := NewService()
	for i := 0; i < 1500; i++ {
		m.Timing("req_time", float64(i))
	}
	snap := m.GetMetrics()
	timing, ok := snap.Timings["req_time"]
	if !ok {
		t.Fatal("timing not found")
	}
	if timing.Count > MaxTimingSamples {
		t.Errorf("timing samples count %d exceeds MaxTimingSamples %d", timing.Count, MaxTimingSamples)
	}
}
