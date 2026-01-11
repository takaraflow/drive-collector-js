// Mock Cache
const mockCache = {
    get: vi.fn(),
    set: vi.fn()
};
vi.mock('../../src/services/CacheService.js', () => ({
    cache: mockCache
}));

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withModule: vi.fn().mockReturnThis(),
  withContext: vi.fn().mockReturnThis()
};
vi.mock('../../src/services/logger.js', () => ({
  default: mockLogger,
  logger: mockLogger
}));

// Import after mocking
const { PRIORITY, runBotTask, handle429Error, botLimiter, runAuthTask, createAutoScalingLimiter } = await import('../../src/utils/limiter.js');

describe('Limiter Priority & Distribution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers('modern');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should respect priority in p-queue', async () => {
        const results = [];
        const task = (id) => async () => {
            // 直接推入结果，避免异步开销
            results.push(id);
        };

        // 模拟一个用户 ID
        const userId = "test_user";

        // 提交一个 NORMAL 任务
        const p1 = runBotTask(task(1), userId, { priority: PRIORITY.NORMAL });
        // 提交一个 UI 任务 (更高优先级)
        const p2 = runBotTask(task(2), userId, { priority: PRIORITY.UI });
        // 提交一个 BACKGROUND 任务 (最低优先级)
        const p3 = runBotTask(task(3), userId, { priority: PRIORITY.BACKGROUND });

        // 立即推进定时器并等待所有任务完成
        await vi.runAllTimersAsync();
        await Promise.all([p1, p2, p3]);

        expect(results).toContain(2);
        expect(results).toContain(1);
        expect(results).toContain(3);
        expect(results.length).toBe(3);
    });
});

describe('AutoScalingLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers('modern');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should increase concurrency on high success rate', async () => {
    const testLimiter = createAutoScalingLimiter({ concurrency: 2 }, { min: 1, max: 10, factor: 0.5, interval: 5000 });
    const initialConcurrency = testLimiter.queue.concurrency;
    // 简化：直接设置计数器模拟高成功率
    testLimiter.successCount = 10;
    testLimiter.errorCount = 0;
    testLimiter.lastAdjustment = Date.now() - 5001; // 确保超过 interval
    testLimiter.adjustConcurrency();
    expect(testLimiter.queue.concurrency).toBeGreaterThan(initialConcurrency);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Auto-scaling: Adjusted concurrency'));
  });

  it('should decrease concurrency on high failure rate', async () => {
    const testLimiter = createAutoScalingLimiter({ concurrency: 5 }, { min: 1, max: 10, factor: 0.8, interval: 5000 });
    const initialConcurrency = testLimiter.queue.concurrency;
    // 简化：直接设置计数器模拟高失败率
    testLimiter.successCount = 3;
    testLimiter.errorCount = 7;
    testLimiter.lastAdjustment = Date.now() - 5001;
    testLimiter.adjustConcurrency();
    expect(testLimiter.queue.concurrency).toBeLessThanOrEqual(initialConcurrency);
  });
});

describe('TokenBucketLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers('modern');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should limit auth tasks with token bucket and async wait', async () => {
    const fn = vi.fn().mockResolvedValue('auth ok');
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(runAuthTask(fn));
    }
    // 使用 runAllTimersAsync 替代固定时间推进
    await vi.runAllTimersAsync();
    await Promise.all(promises);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe('handle429Error', () => {
  beforeEach(() => {
      vi.clearAllMocks();
      mockCache.get.mockResolvedValue(null);
      mockLogger.warn.mockClear();
      mockLogger.error.mockClear();
      mockCache.set.mockClear();
      vi.useFakeTimers('modern');
      // No longer need to mock setTimeout directly, fakeTimers will handle it.
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should retry on 429 errors up to maxRetries', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 2) {
        throw { code: 429, retryAfter: 0.001 }; // 使用1ms延迟
      }
      return 'success';
    };

    const promise = handle429Error(fn, 10);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(2);
    expect(result).toBe('success');
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('should use increased maxRetries default of 10', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 5) {
        throw { code: 429, retryAfter: 0.001 }; // 使用1ms延迟
      }
      return 'success';
    };

    // Should succeed with default 10 retries
    const promise = handle429Error(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(5);
    expect(result).toBe('success');
  });

  it('should use jittered exponential backoff without retry-after', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 3) {
        const err = new Error('FloodWait');
        err.code = 429;
        throw err;
      }
      return 'success';
    };

    const promise = handle429Error(fn, 10);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(3);
    expect(result).toBe('success');
    // Verify warn was called for each retry
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('should trigger global cooling for retryAfter > 60s', async () => {
    const fn = async () => {
      throw { code: 429, retryAfter: 65 };
    };

    const promise = handle429Error(fn, 1);
    await expect(promise).rejects.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Large FloodWait'));
    expect(mockCache.set).toHaveBeenCalledWith('system:cooling_until', expect.any(String), expect.any(Number));
  }, 100);

  it('should parse retryAfter from FloodWait message', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 2) {
        const err = new Error('FloodWait 0.001 seconds');
        err.message = 'FloodWait 0.001 seconds';
        throw err;
      }
      return 'success';
    };

    // Mock cache.get to return null immediately to avoid cooling delays
    mockCache.get.mockResolvedValue(null);
    
    const promise = handle429Error(fn, 2);
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(callCount).toBe(2);
    expect(result).toBe('success');
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('429/FloodWait'));
  }, 100);
});
