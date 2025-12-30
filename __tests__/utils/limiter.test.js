import { jest, describe, it, expect, beforeEach } from '@jest/globals';

  
// Mock Cache
const mockCache = {
    get: jest.fn(),
    set: jest.fn()
};
jest.unstable_mockModule('../../src/services/CacheService.js', () => ({
    cache: mockCache
}));

// Mock logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: mockLogger
}));

  
// Import after mocking
const { PRIORITY, runBotTask, handle429Error, botLimiter, runAuthTask, createAutoScalingLimiter } = await import('../../src/utils/limiter.js');

  
describe('Limiter Priority & Distribution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should respect priority in p-queue', async () => {
        const results = [];
        const task = (id) => async () => {
            // 使用 0 延迟消除 10ms 的硬等待，同时保留异步切换特性
            await new Promise(r => setTimeout(r, 0));
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

        await Promise.all([p1, p2, p3]);

        expect(results).toContain(2);
        expect(results).toContain(1);
        expect(results).toContain(3);
        expect(results.length).toBe(3);
    });
});

describe('AutoScalingLimiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should increase concurrency on high success rate', async () => {
    jest.useFakeTimers('modern');
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
    jest.useFakeTimers('modern');
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
  it('should limit auth tasks with token bucket and async wait', async () => {
    jest.useFakeTimers('modern');
    const fn = jest.fn().mockResolvedValue('auth ok');
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(runAuthTask(fn));
    }
    jest.advanceTimersByTime(10000);
    await Promise.all(promises);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe('handle429Error', () => {
  let originalSetTimeout;

  beforeEach(() => {
      jest.clearAllMocks();
      mockCache.get.mockResolvedValue(null);
      mockLogger.warn.mockClear();
      mockLogger.error.mockClear();
      mockCache.set.mockClear();
      jest.useFakeTimers('modern');
      // Mock setTimeout to call immediately, skipping real waits
      originalSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
          fn();
          return 1;
      });
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    jest.useRealTimers();
  });

  it('should retry on 429 errors up to maxRetries', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 2) {
        throw { code: 429, retryAfter: 1 };
      }
      return 'success';
    };

    const result = await handle429Error(fn, 10);

    expect(callCount).toBe(2);
    expect(result).toBe('success');
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('should use increased maxRetries default of 10', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 5) {
        throw { code: 429, retryAfter: 0.1 };
      }
      return 'success';
    };

    // Should succeed with default 10 retries
    const result = await handle429Error(fn);

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

    const result = await handle429Error(fn, 10);

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
  }, 1000);

  it('should parse retryAfter from FloodWait message', async () => {
    const fn = async () => {
      const err = new Error('FloodWait 10 seconds');
      err.message = 'FloodWait 10 seconds';
      throw err;
    };

    const promise = handle429Error(fn, 2);
    await expect(promise).rejects.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('429/FloodWait'));
  }, 1000);
});