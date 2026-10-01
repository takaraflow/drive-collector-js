package shadow

import (
	"context"
	"sync"
	"testing"

	"github.com/gotd/td/tg"
)

// TestConcurrentOnUpdateIsRaceFree byFingerprint 是裸 map,没有锁。
//
// gotd 的 UpdateHandler 是从多个 goroutine 调用的 —— 这个测试必须
// 能在 -race 下真的并发,否则 race detector 只会因为「没人并发调」
// 而报 OK,给出虚假的安全感。
func TestConcurrentOnUpdateIsRaceFree(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()

	const workers = 8
	const perWorker = 50

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				// 每次构造【新的】update 对象 —— gramjs/gotd 消费过的
				// 对象会被标记已读,复用同一个会导致后续都被跳过。
				_ = c.onUpdate(ctx, &tg.Updates{
					Date:    1700000000,
					Updates: []tg.UpdateClass{newMessageForRace(i)},
				})
			}
		}(w)
	}
	wg.Wait()

	got := c.observer.Total()
	want := workers * perWorker
	if got != want {
		t.Errorf("记录 %d 次,期望 %d —— 并发下有丢失", got, want)
	}
}

func newMessageForRace(pts int) *tg.UpdateNewMessage {
	return &tg.UpdateNewMessage{
		Message:  &tg.MessageEmpty{ID: pts},
		Pts:      pts,
		PtsCount: 1,
	}
}

// TestConcurrentDiffIsRaceFree diff 读 byFingerprint 时,记录可能还在写。
func TestConcurrentDiffIsRaceFree(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()

	stop := make(chan struct{})
	var wg sync.WaitGroup

	// 写侧
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				_ = c.onUpdate(ctx, &tg.Updates{
					Date:    1,
					Updates: []tg.UpdateClass{newMessageForRace(1)},
				})
			}
		}
	}()

	// 读侧
	for i := 0; i < 200; i++ {
		_ = DiffSummaries(
			map[string]int{"t=1f2b0afd|media=false|text=0|gid=": i},
			c.observer.Snapshot(),
			"",
		)
	}

	close(stop)
	wg.Wait()
}
