package telegram

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTokenBucket(t *testing.T) {
	curr := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tb := NewTokenBucket(5, 1) // 5 capacity, 1 token/sec
	tb.nowFunc = func() time.Time { return curr }

	// 连续消耗 5 个令牌成功
	for i := 0; i < 5; i++ {
		if !tb.Take(1) {
			t.Fatalf("take %d should succeed", i)
		}
	}

	// 第 6 个令牌耗尽
	if tb.Take(1) {
		t.Fatalf("token bucket should be empty")
	}

	// 时间前进 2 秒
	curr = curr.Add(2 * time.Second)
	if !tb.Take(2) {
		t.Fatalf("take 2 after 2s refill should succeed")
	}
	if tb.Take(1) {
		t.Fatalf("should have no more tokens")
	}

	// 测试 context 取消下的 Wait
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := tb.Wait(ctx, 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestParseFloodWaitSeconds(t *testing.T) {
	cases := []struct {
		errText     string
		expectedSec int
		expectedOk  bool
	}{
		{"rpc error: FLOOD_WAIT_42", 42, true},
		{"Please wait 15 seconds before retrying", 15, true},
		{"A wait 60 second error", 60, true},
		{"HTTP 429 Too Many Requests", 3, true},
		{"something else went wrong", 0, false},
	}

	for _, c := range cases {
		var err error
		if c.errText != "" {
			err = errors.New(c.errText)
		}
		sec, ok := ParseFloodWaitSeconds(err)
		if ok != c.expectedOk || sec != c.expectedSec {
			t.Errorf("input %q: got (%d, %v), want (%d, %v)", c.errText, sec, ok, c.expectedSec, c.expectedOk)
		}
	}
}

func TestFloodProtector_RetryAndCooling(t *testing.T) {
	fp := NewFloodProtector(3)
	mockTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fp.nowFunc = func() time.Time { return mockTime }

	var sleptDurations []time.Duration
	fp.sleepFunc = func(ctx context.Context, d time.Duration) error {
		sleptDurations = append(sleptDurations, d)
		mockTime = mockTime.Add(d)
		return nil
	}

	attempts := 0
	err := fp.ExecuteWithRetry(context.Background(), func() error {
		attempts++
		if attempts < 3 {
			return errors.New("FLOOD_WAIT_2")
		}
		return nil
	})

	if err != nil {
		t.Fatalf("expected success after retry, got: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts)
	}
	if len(sleptDurations) != 2 {
		t.Fatalf("expected 2 sleeps, got %d", len(sleptDurations))
	}

	// 测试大 FloodWait (>60s) 触发全局冷静期
	attempts = 0
	_ = fp.ExecuteWithRetry(context.Background(), func() error {
		attempts++
		return errors.New("FLOOD_WAIT_70")
	})

	cooling, rem := fp.IsCooling()
	if !cooling || rem <= 0 {
		t.Fatalf("expected system to be in cooling state after 70s flood wait")
	}
}

func TestTokenBucketDefaultNowFunc(t *testing.T) {
	tb := NewTokenBucket(1, 100) // 1 capacity, 100 token/sec
	if !tb.Take(1) {
		t.Fatal("first take should succeed")
	}
	if tb.Take(1) {
		t.Fatal("second take immediately should fail")
	}
	time.Sleep(25 * time.Millisecond)
	if !tb.Take(1) {
		t.Fatal("take after real elapsed time should succeed with default nowFunc")
	}
}
