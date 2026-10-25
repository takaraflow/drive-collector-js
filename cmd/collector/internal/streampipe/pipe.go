package streampipe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

// PipeOptions 管道直传参数。
type PipeOptions struct {
	Watchdog WatchdogOptions
}

// Pipe 将生产者 producer 与消费者 consumer 跨 goroutine 连接，
// 实现零磁盘占用的边下边传（Gotd -> io.Pipe -> Rclone rcat）。
//
// 健壮性保证：
// 1. 生产者故障时，CloseWithError 通知消费者立即退出，避免消费者挂起等待。
// 2. 消费者故障时，CloseWithError 通知生产者立即终止读取网络，避免无谓消耗上游流量。
// 3. 任何一方停滞超过 Watchdog.IdleTimeout 时，看门狗自动熔断并报错 ErrStreamStalled。
func Pipe(
	ctx context.Context,
	producer func(w io.Writer) error,
	consumer func(r io.Reader) error,
	opts PipeOptions,
) (WatchdogStats, error) {
	if producer == nil || consumer == nil {
		return WatchdogStats{}, errors.New("streampipe: producer 和 consumer 不能为空")
	}

	pipeCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	pr, pw := io.Pipe()

	dog := NewWatchdog(opts.Watchdog, func(stallErr error) {
		cancel(stallErr)
		_ = pw.CloseWithError(stallErr)
		_ = pr.CloseWithError(stallErr)
	})
	dog.Start(pipeCtx)
	defer dog.Stop()

	go func() {
		<-pipeCtx.Done()
		cause := context.Cause(pipeCtx)
		if cause == nil {
			cause = pipeCtx.Err()
		}
		_ = pw.CloseWithError(cause)
		_ = pr.CloseWithError(cause)
	}()

	watchedWriter := dog.WatchedWriter(pw)
	watchedReader := pr

	var (
		wg          sync.WaitGroup
		producerErr error
		consumerErr error
	)

	wg.Add(2)

	// 生产者 Goroutine (例如: Gotd 下载流)
	go func() {
		defer wg.Done()
		err := producer(watchedWriter)
		if err != nil {
			producerErr = err
			_ = pw.CloseWithError(err)
		} else {
			_ = pw.Close()
		}
	}()

	// 消费者 Goroutine (例如: Rclone rcat 上传流)
	go func() {
		defer wg.Done()
		err := consumer(watchedReader)
		if err != nil {
			consumerErr = err
			_ = pr.CloseWithError(err)
		} else {
			_ = pr.Close()
		}
	}()

	wg.Wait()

	stats := dog.Stats()

	// 优先检查看门狗熔断
	if cause := context.Cause(pipeCtx); errors.Is(cause, ErrStreamStalled) {
		return stats, ErrStreamStalled
	}
	if ctx.Err() != nil {
		return stats, ctx.Err()
	}

	if producerErr != nil && consumerErr != nil {
		if errors.Is(consumerErr, producerErr) || errors.Is(consumerErr, io.ErrClosedPipe) {
			return stats, fmt.Errorf("streampipe: 生产端出错: %w", producerErr)
		}
		if errors.Is(producerErr, consumerErr) || errors.Is(producerErr, io.ErrClosedPipe) {
			return stats, fmt.Errorf("streampipe: 消费端出错: %w", consumerErr)
		}
		return stats, fmt.Errorf("streampipe: 上下游均出错: %w", errors.Join(producerErr, consumerErr))
	}
	if producerErr != nil {
		return stats, fmt.Errorf("streampipe: 生产端出错: %w", producerErr)
	}
	if consumerErr != nil {
		return stats, fmt.Errorf("streampipe: 消费端出错: %w", consumerErr)
	}

	return stats, nil
}
