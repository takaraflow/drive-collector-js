import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RateLimiter, { createRateLimiter, upstashRateLimiter } from '../../../src/utils/RateLimiter.js';

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis()
    }
}));

describe('RateLimiter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2023-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('Constructor', () => {
        it('should initialize with provided values', () => {
            const limiter = new RateLimiter(10, 1000);
            const status = limiter.getStatus();
            expect(status.maxRequests).toBe(10);
            expect(status.currentTokens).toBe(10);
            expect(status.windowMs).toBe(1000);
            expect(status.isAdaptive).toBe(false);
        });

        it('should initialize with adaptive options', () => {
            const limiter = new RateLimiter(10, 1000, {
                adaptive: true,
                minRequests: 5,
                maxRequests: 20
            });
            const status = limiter.getStatus();
            expect(status.isAdaptive).toBe(true);
            expect(limiter.minRequests).toBe(5);
            expect(limiter.maxRequestsLimit).toBe(20);
        });
    });

    describe('acquire', () => {
        it('should allow requests within limit', async () => {
            const limiter = new RateLimiter(2, 1000);
            const res1 = await limiter.acquire();
            const res2 = await limiter.acquire();

            expect(res1).toBe(true);
            expect(res2).toBe(true);
            expect(limiter.tokens).toBe(0);
        });

        it('should wait when tokens are exhausted', async () => {
            const limiter = new RateLimiter(1, 1000);
            await limiter.acquire(); // tokens = 0

            const acquirePromise = limiter.acquire();

            // Fast-forward time
            vi.advanceTimersByTime(1000);

            const result = await acquirePromise;
            expect(result).toBe(true);
            expect(limiter.tokens).toBe(0); // refill to 1, then consumed
        });

        it('should refill tokens after windowMs', async () => {
            const limiter = new RateLimiter(1, 1000);
            await limiter.acquire();
            expect(limiter.tokens).toBe(0);

            vi.advanceTimersByTime(1000);

            // Next acquire will refill and consume
            await limiter.acquire();
            expect(limiter.tokens).toBe(0);
        });
    });

    describe('execute', () => {
        it('should execute the provided function', async () => {
            const limiter = new RateLimiter(5, 1000);
            const fn = vi.fn().mockResolvedValue('success');

            const result = await limiter.execute(fn);

            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should track latency and stats', async () => {
            const limiter = new RateLimiter(5, 1000);
            const fn = async () => {
                vi.advanceTimersByTime(50);
                return 'done';
            };

            await limiter.execute(fn);

            expect(limiter.stats.totalRequests).toBe(1);
            expect(limiter.stats.averageLatency).toBeGreaterThan(0);
        });

        it('should handle function errors', async () => {
            const limiter = new RateLimiter(5, 1000);
            const fn = vi.fn().mockRejectedValue(new Error('fail'));

            await expect(limiter.execute(fn)).rejects.toThrow('fail');
            expect(limiter.failureCount).toBe(1);
        });
    });

    describe('_adjustIfNeeded (Adaptive)', () => {
        it('should not adjust before interval', () => {
            const limiter = new RateLimiter(10, 1000, { adaptive: true, adjustmentInterval: 60000 });
            limiter.successCount = 10;
            limiter.stats.averageLatency = 50;

            vi.advanceTimersByTime(30000);
            limiter._adjustIfNeeded();

            expect(limiter.maxRequests).toBe(10);
        });

        it('should increase rate limit when success rate is high and latency is low', () => {
            const limiter = new RateLimiter(10, 1000, { adaptive: true, adjustmentInterval: 60000 });
            limiter.successCount = 10;
            limiter.failureCount = 0;
            limiter.stats.averageLatency = 50;

            vi.advanceTimersByTime(60001);
            limiter._adjustIfNeeded();

            expect(limiter.maxRequests).toBe(11);
        });

        it('should decrease rate limit when success rate is low', () => {
            const limiter = new RateLimiter(10, 1000, { adaptive: true, adjustmentInterval: 60000 });
            limiter.successCount = 5;
            limiter.failureCount = 5; // 50% success rate
            limiter.stats.averageLatency = 50;

            vi.advanceTimersByTime(60001);
            limiter._adjustIfNeeded();

            expect(limiter.maxRequests).toBe(9);
        });

        it('should decrease rate limit when latency is high', () => {
            const limiter = new RateLimiter(10, 1000, { adaptive: true, adjustmentInterval: 60000 });
            limiter.successCount = 10;
            limiter.failureCount = 0;
            limiter.stats.averageLatency = 600;

            vi.advanceTimersByTime(60001);
            limiter._adjustIfNeeded();

            expect(limiter.maxRequests).toBe(9);
        });
    });

    describe('updateConfig', () => {
        it('should update maxRequests and windowMs', () => {
            const limiter = new RateLimiter(10, 1000);
            limiter.updateConfig(20, 2000);

            expect(limiter.maxRequests).toBe(20);
            expect(limiter.windowMs).toBe(2000);
            expect(limiter.tokens).toBe(20);
        });
    });

    describe('resetStats', () => {
        it('should reset all statistics', () => {
            const limiter = new RateLimiter(10, 1000);
            limiter.stats.totalRequests = 100;
            limiter.successCount = 50;

            limiter.resetStats();

            expect(limiter.stats.totalRequests).toBe(0);
            expect(limiter.successCount).toBe(0);
        });
    });

    describe('Factory functions', () => {
        it('createRateLimiter should create an instance', () => {
            const limiter = createRateLimiter({ maxRequests: 15, windowMs: 5000 });
            expect(limiter).toBeInstanceOf(RateLimiter);
            expect(limiter.maxRequests).toBe(15);
            expect(limiter.windowMs).toBe(5000);
        });

        it('upstashRateLimiter should be exported', () => {
            expect(upstashRateLimiter).toBeInstanceOf(RateLimiter);
        });
    });
});
