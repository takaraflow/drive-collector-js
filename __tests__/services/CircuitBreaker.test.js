// Mock logger
vi.mock('../../src/services/logger/index.js', () => {
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    };
    return {
        default: mockLogger,
        logger: mockLogger,
        createLogger: vi.fn(() => mockLogger)
    };
});

const { CircuitBreaker, CircuitBreakerManager } = await import('../../src/services/CircuitBreaker.js');

describe('CircuitBreaker', () => {
    let circuitBreaker;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        circuitBreaker = new CircuitBreaker({ name: 'test-breaker' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('constructor', () => {
        test('should initialize with default values', () => {
            const cb = new CircuitBreaker();
            expect(cb.state).toBe('CLOSED');
            expect(cb.failureThreshold).toBe(5);
            expect(cb.successThreshold).toBe(2);
            expect(cb.timeout).toBe(30000);
            expect(cb.failureCount).toBe(0);
            expect(cb.successCount).toBe(0);
            expect(cb.lastFailureTime).toBeNull();
        });

        test('should accept custom options', () => {
            const cb = new CircuitBreaker({
                name: 'custom',
                failureThreshold: 10,
                successThreshold: 3,
                timeout: 60000
            });
            expect(cb.name).toBe('custom');
            expect(cb.failureThreshold).toBe(10);
            expect(cb.successThreshold).toBe(3);
            expect(cb.timeout).toBe(60000);
        });
    });

    describe('execute', () => {
        test('should execute successfully when CLOSED', async () => {
            const mockFn = vi.fn().mockResolvedValue('success');
            const result = await circuitBreaker.execute(mockFn);
            
            expect(result).toBe('success');
            expect(mockFn).toHaveBeenCalledTimes(1);
            expect(circuitBreaker.state).toBe('CLOSED');
            expect(circuitBreaker.failureCount).toBe(0);
        });

        test('should handle failures and increment count', async () => {
            const error = new Error('test error');
            const mockFn = vi.fn().mockRejectedValue(error);
            
            await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
            
            expect(circuitBreaker.failureCount).toBe(1);
            expect(circuitBreaker.state).toBe('CLOSED');
        });

        test('should open after failure threshold reached', async () => {
            const error = new Error('test error');
            const mockFn = vi.fn().mockRejectedValue(error);
            
            // Trigger failures to reach threshold
            for (let i = 0; i < 5; i++) {
                await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
            }
            
            // 状态更新是同步的，直接验证
            expect(circuitBreaker.state).toBe('OPEN');
            expect(circuitBreaker.failureCount).toBe(5);
            expect(circuitBreaker.lastFailureTime).toBeGreaterThanOrEqual(0);
        });

        test('should reject immediately when OPEN', async () => {
            // Force open state
            circuitBreaker.state = 'OPEN';
            circuitBreaker.lastFailureTime = Date.now();
            
            const mockFn = vi.fn().mockResolvedValue('success');
            
            await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('Circuit breaker is OPEN for test-breaker');
            expect(mockFn).not.toHaveBeenCalled();
        });

        test('should allow execution with fallback when OPEN', async () => {
            circuitBreaker.state = 'OPEN';
            circuitBreaker.lastFailureTime = Date.now();
            
            const mockFn = vi.fn().mockResolvedValue('success');
            const fallbackFn = vi.fn().mockReturnValue('fallback');
            
            const result = await circuitBreaker.execute(mockFn, fallbackFn);
            
            expect(result).toBe('fallback');
            expect(mockFn).not.toHaveBeenCalled();
            expect(fallbackFn).toHaveBeenCalledTimes(1);
        });

        test('should transition to HALF_OPEN after timeout', async () => {
            const error = new Error('test error');
            const mockFn = vi.fn().mockRejectedValue(error);
            
            // Open circuit
            for (let i = 0; i < 5; i++) {
                await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
            }
            
            expect(circuitBreaker.state).toBe('OPEN');
            
            // Fast forward past timeout
            vi.advanceTimersByTime(31000);
            
            // Next call should allow execution
            const successFn = vi.fn().mockResolvedValue('success');
            const result = await circuitBreaker.execute(successFn);
            
            expect(result).toBe('success');
            expect(circuitBreaker.state).toBe('HALF_OPEN');
            expect(circuitBreaker.successCount).toBe(1);
        });

        test('should close after success threshold in HALF_OPEN', async () => {
            // Open circuit
            const error = new Error('test error');
            const mockFn = vi.fn().mockRejectedValue(error);
            for (let i = 0; i < 5; i++) {
                await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
            }
            
            // Advance to HALF_OPEN
            vi.advanceTimersByTime(31000);
            
            // Successful executions
            const successFn = vi.fn().mockResolvedValue('success');
            for (let i = 0; i < 2; i++) {
                await circuitBreaker.execute(successFn);
            }
            
            expect(circuitBreaker.state).toBe('CLOSED');
            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.successCount).toBe(0);
        });

        test('should reopen on failure in HALF_OPEN', async () => {
            // Open circuit
            const error = new Error('test error');
            const mockFn = vi.fn().mockRejectedValue(error);
            for (let i = 0; i < 5; i++) {
                await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
            }
            
            // Advance to HALF_OPEN
            vi.advanceTimersByTime(31000);
            
            // Fail in HALF_OPEN
            await expect(circuitBreaker.execute(mockFn)).rejects.toThrow('test error');
            
            expect(circuitBreaker.state).toBe('OPEN');
            expect(circuitBreaker.failureCount).toBe(6);
        });

        test('should not increment success count in CLOSED state', async () => {
            const successFn = vi.fn().mockResolvedValue('success');
            await circuitBreaker.execute(successFn);
            
            expect(circuitBreaker.successCount).toBe(0);
        });
    });

    describe('getStatus', () => {
        test('should return current status', () => {
            const status = circuitBreaker.getStatus();
            
            expect(status).toEqual({
                name: 'test-breaker',
                state: 'CLOSED',
                failureCount: 0,
                successCount: 0,
                lastFailureTime: null,
                threshold: 5
            });
        });

        test('should include failure time when set', () => {
            const testTime = Date.now();
            circuitBreaker.lastFailureTime = testTime;
            const status = circuitBreaker.getStatus();
            
            expect(status.lastFailureTime).toBe(testTime);
        });
    });

    describe('reset', () => {
        test('should reset all counters and state', () => {
            circuitBreaker.state = 'OPEN';
            circuitBreaker.failureCount = 3;
            circuitBreaker.successCount = 1;
            circuitBreaker.lastFailureTime = new Date();
            
            circuitBreaker.reset();
            
            expect(circuitBreaker.state).toBe('CLOSED');
            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.successCount).toBe(0);
            expect(circuitBreaker.lastFailureTime).toBeNull();
        });
    });

    describe('forceOpen', () => {
        test('should force open state immediately', () => {
            circuitBreaker.forceOpen();
            
            expect(circuitBreaker.state).toBe('OPEN');
            expect(circuitBreaker.lastFailureTime).toBeGreaterThanOrEqual(0);
            expect(circuitBreaker.failureCount).toBe(0);
        });
    });
});

describe('CircuitBreakerManager', () => {
    beforeEach(() => {
        CircuitBreakerManager.breakers.clear();
    });

    describe('get', () => {
        test('should create new breaker if not exists', () => {
            const breaker = CircuitBreakerManager.get('test1', { failureThreshold: 10 });
            
            expect(breaker).toBeInstanceOf(CircuitBreaker);
            expect(breaker.name).toBe('test1');
            expect(breaker.failureThreshold).toBe(10);
        });

        test('should return existing breaker if exists', () => {
            const breaker1 = CircuitBreakerManager.get('test1', { failureThreshold: 10 });
            const breaker2 = CircuitBreakerManager.get('test1', { failureThreshold: 20 });
            
            expect(breaker1).toBe(breaker2);
            expect(breaker1.failureThreshold).toBe(10); // Original settings preserved
        });
    });

    describe('getAllStatus', () => {
        test('should return empty array when no breakers', () => {
            const statuses = CircuitBreakerManager.getAllStatus();
            expect(statuses).toEqual([]);
        });

        test('should return status of all breakers', () => {
            const breaker1 = CircuitBreakerManager.get('test1');
            const breaker2 = CircuitBreakerManager.get('test2');
            
            const statuses = CircuitBreakerManager.getAllStatus();
            
            expect(statuses).toHaveLength(2);
            expect(statuses[0].name).toBe('test1');
            expect(statuses[1].name).toBe('test2');
        });
    });

    describe('resetAll', () => {
        test('should reset all breakers', () => {
            const breaker1 = CircuitBreakerManager.get('test1');
            const breaker2 = CircuitBreakerManager.get('test2');
            
            // Modify breakers
            breaker1.forceOpen();
            breaker2.state = 'OPEN';
            
            CircuitBreakerManager.resetAll();
            
            expect(breaker1.state).toBe('CLOSED');
            expect(breaker2.state).toBe('CLOSED');
        });
    });
});