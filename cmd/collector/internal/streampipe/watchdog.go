package streampipe

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// ErrStreamStalled 在传输流出现空闲无响应或速度持续过低时返回。
var ErrStreamStalled = errors.New("streampipe: 流传输超时挂起(卡死)")

// WatchdogOptions 看门狗参数。
type WatchdogOptions struct {
	IdleTimeout   time.Duration // 最大无数据时间，默认 30s
	CheckInterval time.Duration // 采样周期，默认 1s
	MinSpeedBps   int64         // 触发低速判定的阈值，0 为仅判定空闲
}

// WatchdogStats 运行统计。
type WatchdogStats struct {
	TotalBytes      int64
	CurrentSpeedBps int64
	AverageSpeedBps int64
	Elapsed         time.Duration
}

// SpeedWatchdog 监控流读写的吞吐速率与健康度。
type SpeedWatchdog struct {
	opts       WatchdogOptions
	totalBytes atomic.Int64
	lastBytes  int64
	lastActive atomic.Int64 // UnixMilli
	startTime  time.Time
	mu         sync.Mutex
	stalled    atomic.Bool
	stopCh     chan struct{}
	onStall    func(error)
}

// NewWatchdog 构造速率与空闲看门狗。
func NewWatchdog(opts WatchdogOptions, onStall func(error)) *SpeedWatchdog {
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = 30 * time.Second
	}
	if opts.CheckInterval <= 0 {
		opts.CheckInterval = 1 * time.Second
	}

	w := &SpeedWatchdog{
		opts:      opts,
		startTime: time.Now(),
		stopCh:    make(chan struct{}),
		onStall:   onStall,
	}
	w.lastActive.Store(time.Now().UnixMilli())
	return w
}

// Start 启动后台采样检测。
func (w *SpeedWatchdog) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(w.opts.CheckInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-w.stopCh:
				return
			case <-ticker.C:
				now := time.Now()
				nowMs := now.UnixMilli()
				lastAct := w.lastActive.Load()

				// 1. 检查是否空闲超时
				if nowMs-lastAct > w.opts.IdleTimeout.Milliseconds() {
					if w.stalled.CompareAndSwap(false, true) {
						if w.onStall != nil {
							w.onStall(ErrStreamStalled)
						}
						return
					}
				}

				// 2. 采样瞬时速度
				w.mu.Lock()
				curTotal := w.totalBytes.Load()
				w.lastBytes = curTotal
				w.mu.Unlock()
			}
		}
	}()
}

// Stop 停止监控。
func (w *SpeedWatchdog) Stop() {
	select {
	case <-w.stopCh:
	default:
		close(w.stopCh)
	}
}

// RecordActivity 记录活跃流量。
func (w *SpeedWatchdog) RecordActivity(bytesCount int) {
	if bytesCount > 0 {
		w.totalBytes.Add(int64(bytesCount))
		w.lastActive.Store(time.Now().UnixMilli())
	}
}

// Stats 获取当前传输统计数据。
func (w *SpeedWatchdog) Stats() WatchdogStats {
	w.mu.Lock()
	defer w.mu.Unlock()

	total := w.totalBytes.Load()
	elapsed := time.Since(w.startTime)
	var avgSpeed int64
	if elapsed.Seconds() > 0 {
		avgSpeed = int64(float64(total) / elapsed.Seconds())
	}

	return WatchdogStats{
		TotalBytes:      total,
		AverageSpeedBps: avgSpeed,
		Elapsed:         elapsed,
	}
}

// WatchedWriter 包装 io.Writer。
func (w *SpeedWatchdog) WatchedWriter(writer io.Writer) io.Writer {
	return &watchWriter{w: writer, dog: w}
}

// WatchedReader 包装 io.Reader。
func (w *SpeedWatchdog) WatchedReader(reader io.Reader) io.Reader {
	return &watchReader{r: reader, dog: w}
}

type watchWriter struct {
	w   io.Writer
	dog *SpeedWatchdog
}

func (ww *watchWriter) Write(p []byte) (n int, err error) {
	n, err = ww.w.Write(p)
	if n > 0 {
		ww.dog.RecordActivity(n)
	}
	return n, err
}

type watchReader struct {
	r   io.Reader
	dog *SpeedWatchdog
}

func (wr *watchReader) Read(p []byte) (n int, err error) {
	n, err = wr.r.Read(p)
	if n > 0 {
		wr.dog.RecordActivity(n)
	}
	return n, err
}
