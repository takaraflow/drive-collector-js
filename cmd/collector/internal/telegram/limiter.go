package telegram

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TokenBucket 并发安全的令牌桶限流器。
type TokenBucket struct {
	mu         sync.Mutex
	capacity   float64
	fillRate   float64 // 令牌/秒
	tokens     float64
	lastRefill time.Time
	nowFunc    func() time.Time
}

// NewTokenBucket 创建令牌桶。
func NewTokenBucket(capacity float64, fillRate float64) *TokenBucket {
	now := time.Now()
	return &TokenBucket{
		capacity:   capacity,
		fillRate:   fillRate,
		tokens:     capacity,
		lastRefill: now,
		nowFunc:    time.Now,
	}
}

func (tb *TokenBucket) refillLocked() {
	now := tb.nowFunc()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	if elapsed > 0 {
		tb.tokens = math.Min(tb.capacity, tb.tokens+elapsed*tb.fillRate)
		tb.lastRefill = now
	} else if elapsed < 0 {
		// 时间倒退或 mock 注入时对齐
		tb.lastRefill = now
	}
}

// Take 尝试获取指定数量的令牌，非阻塞。
func (tb *TokenBucket) Take(count float64) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	tb.refillLocked()
	if tb.tokens >= count {
		tb.tokens -= count
		return true
	}
	return false
}

// Wait 等待直到获取到足够的令牌，支持 context 取消。
func (tb *TokenBucket) Wait(ctx context.Context, count float64) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		tb.mu.Lock()
		tb.refillLocked()
		if tb.tokens >= count {
			tb.tokens -= count
			tb.mu.Unlock()
			return nil
		}

		needed := count - tb.tokens
		waitSec := needed / tb.fillRate
		tb.mu.Unlock()

		if waitSec < 0.01 {
			waitSec = 0.01
		}
		sleepDur := time.Duration(waitSec * float64(time.Second))
		if sleepDur > time.Second {
			sleepDur = time.Second // 每次最长等待 1s 重新尝试计算
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sleepDur):
		}
	}
}

// ============================================================================
// FloodWait & 429 保护
// ============================================================================

var floodRegex = regexp.MustCompile(`(?i)(?:FLOOD_WAIT_|wait\s+)(\d+)(?:\s+seconds?)?`)

// ParseFloodWaitSeconds 从错误字符串中解析 Telegram 要求的等待秒数。
func ParseFloodWaitSeconds(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	msg := err.Error()
	matches := floodRegex.FindStringSubmatch(msg)
	if len(matches) >= 2 {
		sec, convErr := strconv.Atoi(matches[1])
		if convErr == nil && sec > 0 {
			return sec, true
		}
	}
	if strings.Contains(strings.ToLower(msg), "flood") || strings.Contains(msg, "429") {
		return 3, true
	}
	return 0, false
}

// FloodProtector 统一控制 Telegram MTProto 的洪泛保护与冷静期。
type FloodProtector struct {
	mu                 sync.RWMutex
	globalCoolingUntil time.Time
	maxRetries         int
	nowFunc            func() time.Time
	sleepFunc          func(ctx context.Context, d time.Duration) error
}

// NewFloodProtector 创建洪泛保护器。
func NewFloodProtector(maxRetries int) *FloodProtector {
	if maxRetries <= 0 {
		maxRetries = 5
	}
	return &FloodProtector{
		maxRetries: maxRetries,
		nowFunc:    time.Now,
		sleepFunc: func(ctx context.Context, d time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
				return nil
			}
		},
	}
}

// IsCooling 检查当前系统是否处于全局冷静期中。
func (fp *FloodProtector) IsCooling() (bool, time.Duration) {
	fp.mu.RLock()
	defer fp.mu.RUnlock()

	now := fp.nowFunc()
	if now.Before(fp.globalCoolingUntil) {
		return true, fp.globalCoolingUntil.Sub(now)
	}
	return false, 0
}

// SetCooling 设置全局冷静期。
func (fp *FloodProtector) SetCooling(duration time.Duration) {
	fp.mu.Lock()
	defer fp.mu.Unlock()
	fp.globalCoolingUntil = fp.nowFunc().Add(duration)
}

// ExecuteWithRetry 带 FloodWait 自动重试与全局冷静期保护的执行器。
func (fp *FloodProtector) ExecuteWithRetry(ctx context.Context, fn func() error) error {
	var lastErr error

	for attempt := 0; attempt < fp.maxRetries; attempt++ {
		// 1. 若处于冷静期，先等待冷却
		if cooling, waitDur := fp.IsCooling(); cooling {
			if err := fp.sleepFunc(ctx, waitDur); err != nil {
				return err
			}
		}

		err := fn()
		if err == nil {
			return nil
		}
		lastErr = err

		// 2. 检测 FloodWait / 429
		waitSec, isFlood := ParseFloodWaitSeconds(err)
		if !isFlood {
			return err
		}

		// 指数退避 + 抖动 (0-1s)
		backoff := float64(waitSec)
		if backoff <= 0 {
			backoff = math.Min(math.Pow(2, float64(attempt+1)), 30)
		}
		jitter := rand.Float64()
		waitDuration := time.Duration((backoff + jitter) * float64(time.Second))

		// 超过 60 秒触发全局冷静期，额外预留 60 秒缓冲对齐 JS 端
		if waitSec > 60 {
			fp.SetCooling(waitDuration + 60*time.Second)
		}

		if sleepErr := fp.sleepFunc(ctx, waitDuration); sleepErr != nil {
			return sleepErr
		}
	}

	return fmt.Errorf("flood retry exceeded (%d attempts): %w", fp.maxRetries, lastErr)
}
