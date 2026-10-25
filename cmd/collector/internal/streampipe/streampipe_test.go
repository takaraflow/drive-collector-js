package streampipe

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"testing"
	"time"
)

func TestPipe_Success(t *testing.T) {
	ctx := context.Background()

	// 500KB 测试数据
	data := make([]byte, 500*1024)
	for i := range data {
		data[i] = byte(i % 251)
	}
	expectedHash := sha256.Sum256(data)

	var receivedHash [32]byte
	var receivedBytes int64

	stats, err := Pipe(
		ctx,
		func(w io.Writer) error {
			chunkSize := 16 * 1024
			for offset := 0; offset < len(data); offset += chunkSize {
				end := offset + chunkSize
				if end > len(data) {
					end = len(data)
				}
				if _, err := w.Write(data[offset:end]); err != nil {
					return err
				}
			}
			return nil
		},
		func(r io.Reader) error {
			h := sha256.New()
			n, err := io.Copy(h, r)
			if err != nil {
				return err
			}
			receivedBytes = n
			copy(receivedHash[:], h.Sum(nil))
			return nil
		},
		PipeOptions{
			Watchdog: WatchdogOptions{
				IdleTimeout:   5 * time.Second,
				CheckInterval: 50 * time.Millisecond,
			},
		},
	)

	if err != nil {
		t.Fatalf("Pipe failed unexpectedly: %v", err)
	}

	if receivedBytes != int64(len(data)) {
		t.Errorf("expected %d bytes, got %d", len(data), receivedBytes)
	}
	if !bytes.Equal(receivedHash[:], expectedHash[:]) {
		t.Error("data corruption: hash mismatch")
	}
	if stats.TotalBytes != int64(len(data)) {
		t.Errorf("expected stats.TotalBytes %d, got %d", len(data), stats.TotalBytes)
	}
}

func TestPipe_ProducerError(t *testing.T) {
	ctx := context.Background()
	customErr := errors.New("upstream telegram network disconnected")

	_, err := Pipe(
		ctx,
		func(w io.Writer) error {
			_, _ = w.Write([]byte("some initial data"))
			return customErr
		},
		func(r io.Reader) error {
			buf := make([]byte, 1024)
			for {
				_, err := r.Read(buf)
				if err != nil {
					return err
				}
			}
		},
		PipeOptions{},
	)

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, customErr) {
		t.Errorf("expected customErr in cause chain, got: %v", err)
	}
}

func TestPipe_ConsumerError(t *testing.T) {
	ctx := context.Background()
	customErr := errors.New("rclone remote rejected connection")

	_, err := Pipe(
		ctx,
		func(w io.Writer) error {
			buf := make([]byte, 1024)
			for {
				_, err := w.Write(buf)
				if err != nil {
					return err
				}
			}
		},
		func(r io.Reader) error {
			buf := make([]byte, 100)
			_, _ = r.Read(buf)
			return customErr
		},
		PipeOptions{},
	)

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, customErr) {
		t.Errorf("expected customErr in cause chain, got: %v", err)
	}
}

func TestPipe_WatchdogStall(t *testing.T) {
	ctx := context.Background()

	start := time.Now()
	_, err := Pipe(
		ctx,
		func(w io.Writer) error {
			_, _ = w.Write([]byte("first chunk"))
			// 模拟生产者挂起卡死：持续等待写直到看门狗熔断关管道
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			for range ticker.C {
				// 不写入有效数据，探测管道关闭状态
				if _, err := w.Write(nil); err != nil {
					return err
				}
			}
			return nil
		},
		func(r io.Reader) error {
			buf := make([]byte, 1024)
			for {
				_, err := r.Read(buf)
				if err != nil {
					return err
				}
			}
		},
		PipeOptions{
			Watchdog: WatchdogOptions{
				IdleTimeout:   100 * time.Millisecond, // 100ms 无数据即判定卡死
				CheckInterval: 20 * time.Millisecond,
			},
		},
	)

	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected stall error, got nil")
	}
	if !errors.Is(err, ErrStreamStalled) {
		t.Errorf("expected ErrStreamStalled, got: %v", err)
	}
	if elapsed > 800*time.Millisecond {
		t.Errorf("watchdog took too long to abort: %v", elapsed)
	}
}

func TestPipe_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	_, err := Pipe(
		ctx,
		func(w io.Writer) error {
			for {
				if _, err := w.Write([]byte("infinite")); err != nil {
					return err
				}
				time.Sleep(10 * time.Millisecond)
			}
		},
		func(r io.Reader) error {
			buf := make([]byte, 1024)
			for {
				if _, err := r.Read(buf); err != nil {
					return err
				}
			}
		},
		PipeOptions{},
	)

	if err == nil {
		t.Fatal("expected context cancelled error, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got: %v", err)
	}
}
