package circuitbreaker

import (
	"errors"
	"testing"
	"time"
)

func TestCircuitBreaker_StateTransitions(t *testing.T) {
	currTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	mockNow := func() time.Time {
		return currTime
	}

	cb := NewCircuitBreaker(Options{
		FailureThreshold: 2,
		SuccessThreshold: 2,
		Timeout:          10 * time.Second,
		Name:             "test-service",
		NowFunc:          mockNow,
	})

	if cb.GetStatus().State != StateClosed {
		t.Fatalf("expected initial state CLOSED, got %v", cb.GetStatus().State)
	}

	testErr := errors.New("upstream error")

	// 第一次失败，仍保持 CLOSED
	_ = cb.Execute(func() error {
		return testErr
	})
	if cb.GetStatus().State != StateClosed {
		t.Fatalf("expected state CLOSED after 1 failure, got %v", cb.GetStatus().State)
	}

	// 第二次失败，达到阈值，进入 OPEN
	_ = cb.Execute(func() error {
		return testErr
	})
	if cb.GetStatus().State != StateOpen {
		t.Fatalf("expected state OPEN after 2 failures, got %v", cb.GetStatus().State)
	}

	// OPEN 状态下直接拒绝调用
	called := false
	err := cb.Execute(func() error {
		called = true
		return nil
	})
	if called {
		t.Fatalf("command should not have executed while OPEN")
	}
	if !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("expected ErrCircuitOpen, got %v", err)
	}

	// 时间前进 5 秒（小于 10 秒超时），仍应为 OPEN
	currTime = currTime.Add(5 * time.Second)
	err = cb.Execute(func() error { return nil })
	if !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("expected ErrCircuitOpen before timeout, got %v", err)
	}

	// 时间前进到 11 秒，超时满足，允许探针调用并进入 HALF_OPEN
	currTime = currTime.Add(6 * time.Second)
	probeExecuted := false
	err = cb.Execute(func() error {
		probeExecuted = true
		return nil
	})
	if err != nil || !probeExecuted {
		t.Fatalf("probe execution failed: %v", err)
	}
	if cb.GetStatus().State != StateHalfOpen {
		t.Fatalf("expected state HALF_OPEN after first successful probe, got %v", cb.GetStatus().State)
	}

	// 第二次探针成功，达到 SuccessThreshold (2)，恢复 CLOSED
	err = cb.Execute(func() error { return nil })
	if err != nil {
		t.Fatalf("second probe failed: %v", err)
	}
	if cb.GetStatus().State != StateClosed {
		t.Fatalf("expected state CLOSED after recovery, got %v", cb.GetStatus().State)
	}
}

func TestCircuitBreaker_Fallback(t *testing.T) {
	cb := NewCircuitBreaker(Options{
		FailureThreshold: 1,
	})

	cb.ForceOpen()

	fallbackCalled := false
	err := cb.ExecuteWithFallback(func() error {
		return nil
	}, func(err error) error {
		fallbackCalled = true
		return nil
	})

	if err != nil || !fallbackCalled {
		t.Fatalf("fallback should be invoked when breaker is OPEN")
	}
}

func TestManager(t *testing.T) {
	mgr := NewManager()
	cb1 := mgr.Get("s1", Options{FailureThreshold: 3})
	cb2 := mgr.Get("s1") // 应返回同一实例
	if cb1 != cb2 {
		t.Fatalf("manager should return singleton instance for same name")
	}

	mgr.Get("s2", Options{FailureThreshold: 5})
	statuses := mgr.GetAllStatus()
	if len(statuses) != 2 {
		t.Fatalf("expected 2 statuses, got %d", len(statuses))
	}

	cb1.ForceOpen()
	mgr.ResetAll()
	if cb1.GetStatus().State != StateClosed {
		t.Fatalf("ResetAll should restore CLOSED state")
	}
}

func TestCircuitBreaker_HalfOpenConcurrencySingleProbe(t *testing.T) {
	currTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cb := NewCircuitBreaker(Options{
		FailureThreshold: 1,
		SuccessThreshold: 2,
		Timeout:          10 * time.Second,
		NowFunc:          func() time.Time { return currTime },
	})

	// 1. 触发失败进入 OPEN
	_ = cb.Execute(func() error { return errors.New("fail") })
	if cb.GetStatus().State != StateOpen {
		t.Fatalf("expected OPEN state")
	}

	// 2. 时间跃迁到冷却期后
	currTime = currTime.Add(11 * time.Second)

	// 3. 模拟并发探针：第一个探针启动并阻塞在执行中
	probeStarted := make(chan struct{})
	probeBlock := make(chan struct{})
	probeDone := make(chan struct{})
	var probeErr error

	go func() {
		defer close(probeDone)
		probeErr = cb.Execute(func() error {
			close(probeStarted)
			<-probeBlock
			return nil
		})
	}()

	<-probeStarted

	// 此时状态为 HALF_OPEN，且探针在途。其余并发请求必须被限流拦截，防止压垮后端
	concurrentErr := cb.Execute(func() error {
		return nil
	})
	if !errors.Is(concurrentErr, ErrCircuitOpen) {
		t.Errorf("expected ErrCircuitOpen for concurrent request during half-open probing, got: %v", concurrentErr)
	}

	// 释放第一个探针并等待完成
	close(probeBlock)
	<-probeDone

	if probeErr != nil {
		t.Fatalf("first probe should succeed: %v", probeErr)
	}
}
