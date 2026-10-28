package circuitbreaker

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// State 表示熔断器的当前生命周期状态。
type State string

const (
	StateClosed   State = "CLOSED"
	StateOpen     State = "OPEN"
	StateHalfOpen State = "HALF_OPEN"
)

var (
	// ErrCircuitOpen 当熔断器处于 OPEN 状态且半开超时未满足时返回。
	ErrCircuitOpen = errors.New("circuit breaker is OPEN")
)

// Options 包含熔断器的配置选项。
type Options struct {
	FailureThreshold int           // 触发熔断的连续失败阈值 (默认 5)
	SuccessThreshold int           // 恢复关闭状态所需的连续成功次数 (默认 2)
	Timeout          time.Duration // 从 OPEN 进入 HALF_OPEN 的冷却等待时间 (默认 30s)
	Name             string
	NowFunc          func() time.Time // 用于测试的时间源函数
}

// Status 描述熔断器的当前快照状态，用于监控与诊断。
type Status struct {
	Name            string    `json:"name"`
	State           State     `json:"state"`
	FailureCount    int       `json:"failureCount"`
	SuccessCount    int       `json:"successCount"`
	LastFailureTime time.Time `json:"lastFailureTime,omitempty"`
	Threshold       int       `json:"threshold"`
}

// CircuitBreaker 通用断路器实现，防止下游服务故障引发级联崩溃。
type CircuitBreaker struct {
	mu               sync.Mutex
	name             string
	failureThreshold int
	successThreshold int
	timeout          time.Duration
	now              func() time.Time

	state            State
	failureCount     int
	successCount     int
	halfOpenInflight int
	lastFailureTime  time.Time
}

// NewCircuitBreaker 实例化一个断路器。
func NewCircuitBreaker(opts Options) *CircuitBreaker {
	if opts.FailureThreshold <= 0 {
		opts.FailureThreshold = 5
	}
	if opts.SuccessThreshold <= 0 {
		opts.SuccessThreshold = 2
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 30 * time.Second
	}
	if opts.Name == "" {
		opts.Name = "default"
	}
	if opts.NowFunc == nil {
		opts.NowFunc = time.Now
	}

	return &CircuitBreaker{
		name:             opts.Name,
		failureThreshold: opts.FailureThreshold,
		successThreshold: opts.SuccessThreshold,
		timeout:          opts.Timeout,
		now:              opts.NowFunc,
		state:            StateClosed,
	}
}

// Execute 执行受保护的业务调用。
func (cb *CircuitBreaker) Execute(fn func() error) error {
	return cb.ExecuteWithFallback(fn, nil)
}

// ExecuteWithFallback 执行受保护的函数，在熔断或执行失败时触发降级逻辑。
func (cb *CircuitBreaker) ExecuteWithFallback(fn func() error, fallback func(err error) error) error {
	if err := cb.beforeCall(); err != nil {
		if fallback != nil {
			return fallback(err)
		}
		return err
	}

	err := fn()
	if err != nil {
		cb.afterFailure(err)
		if fallback != nil {
			return fallback(err)
		}
		return err
	}

	cb.afterSuccess()
	return nil
}

func (cb *CircuitBreaker) beforeCall() error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == StateOpen {
		if cb.now().Sub(cb.lastFailureTime) > cb.timeout {
			cb.state = StateHalfOpen
			cb.successCount = 0
			cb.halfOpenInflight = 1
			return nil
		}
		return fmt.Errorf("%w for %s", ErrCircuitOpen, cb.name)
	}

	if cb.state == StateHalfOpen {
		// 半开状态下限制并发探针数为 1，防止瞬时惊群打垮后端
		if cb.halfOpenInflight >= 1 {
			return fmt.Errorf("%w (probing) for %s", ErrCircuitOpen, cb.name)
		}
		cb.halfOpenInflight++
		return nil
	}

	return nil
}

func (cb *CircuitBreaker) afterSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == StateHalfOpen {
		if cb.halfOpenInflight > 0 {
			cb.halfOpenInflight--
		}
		cb.successCount++
		if cb.successCount >= cb.successThreshold {
			cb.resetLocked()
		}
	} else if cb.state == StateClosed {
		cb.failureCount = 0
	}
}

func (cb *CircuitBreaker) afterFailure(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failureCount++
	cb.lastFailureTime = cb.now()

	if cb.state == StateHalfOpen {
		if cb.halfOpenInflight > 0 {
			cb.halfOpenInflight--
		}
		cb.state = StateOpen
	} else if cb.failureCount >= cb.failureThreshold {
		cb.state = StateOpen
	}
}

func (cb *CircuitBreaker) resetLocked() {
	cb.state = StateClosed
	cb.failureCount = 0
	cb.successCount = 0
	cb.halfOpenInflight = 0
	cb.lastFailureTime = time.Time{}
}

// Reset 手动重置断路器到关闭状态。
func (cb *CircuitBreaker) Reset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.resetLocked()
}

// ForceOpen 紧急情况下强制打开断路器。
func (cb *CircuitBreaker) ForceOpen() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.state = StateOpen
	cb.lastFailureTime = cb.now()
}

// GetStatus 获取当前断路器运行快照。
func (cb *CircuitBreaker) GetStatus() Status {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	return Status{
		Name:            cb.name,
		State:           cb.state,
		FailureCount:    cb.failureCount,
		SuccessCount:    cb.successCount,
		LastFailureTime: cb.lastFailureTime,
		Threshold:       cb.failureThreshold,
	}
}

// Manager 统一管理多个具名断路器实例。
type Manager struct {
	mu       sync.RWMutex
	breakers map[string]*CircuitBreaker
}

// NewManager 创建管理器。
func NewManager() *Manager {
	return &Manager{
		breakers: make(map[string]*CircuitBreaker),
	}
}

var defaultManager = NewManager()

// Default 获取全局默认断路器管理器。
func Default() *Manager {
	return defaultManager
}

// Get 获取或创建指定名称的断路器。
func (m *Manager) Get(name string, opts ...Options) *CircuitBreaker {
	m.mu.RLock()
	cb, exists := m.breakers[name]
	m.mu.RUnlock()
	if exists {
		return cb
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if cb, exists = m.breakers[name]; exists {
		return cb
	}

	var opt Options
	if len(opts) > 0 {
		opt = opts[0]
	}
	opt.Name = name
	cb = NewCircuitBreaker(opt)
	m.breakers[name] = cb
	return cb
}

// GetAllStatus 获取全部已注册断路器的状态。
func (m *Manager) GetAllStatus() []Status {
	m.mu.RLock()
	defer m.mu.RUnlock()

	statuses := make([]Status, 0, len(m.breakers))
	for _, cb := range m.breakers {
		statuses = append(statuses, cb.GetStatus())
	}
	return statuses
}

// ResetAll 重置全部断路器。
func (m *Manager) ResetAll() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, cb := range m.breakers {
		cb.Reset()
	}
}
