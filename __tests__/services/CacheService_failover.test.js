/**
 * CacheService Failover Unit Tests
 * Optimized for speed and reliability
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock the logger
jest.mock('../../src/services/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock the rate limiter
jest.mock('../../src/utils/RateLimiter.js', () => ({
    upstashRateLimiter: {
        execute: async (fn) => await fn()
    }
}));

// Mock LocalCache
jest.mock('../../src/utils/LocalCache.js', () => ({
    localCache: {
        set: jest.fn(),
        get: jest.fn(() => null),
        del: jest.fn(),
        isUnchanged: jest.fn(() => false)
    }
}));

describe('KV Service Failover - Unit Tests', () => {
    let originalEnv;
    let cache;

    beforeEach(async () => {
        originalEnv = { ...process.env };
        jest.clearAllMocks();
        
        // Setup default env
        process.env.CACHE_PROVIDER = 'cloudflare';
        process.env.CF_CACHE_ACCOUNT_ID = 'test-account';
        process.env.CF_CACHE_NAMESPACE_ID = 'test-namespace';
        process.env.CF_CACHE_TOKEN = 'test-token';
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;

        // Use a fresh instance for each test to ensure isolation without full resetModules overhead if possible
        // But since CacheService uses process.env in constructor, we need to re-import or re-instantiate
        jest.resetModules();
        const { CacheService } = await import('../../src/services/CacheService.js');
        cache = new CacheService();
        cache.stopRecoveryCheck();
    });

    afterEach(() => {
        process.env = originalEnv;
        if (cache) cache.stopRecoveryCheck();
    });

    test('should use Cloudflare KV by default and handle failover logic', async () => {
        // 1. Default provider
        expect(cache.currentProvider).toBe('cloudflare');
        expect(cache.failoverEnabled).toBe(false); // No upstash yet

        // 2. Enable Upstash and check failoverEnabled
        process.env.UPSTASH_REDIS_REST_URL = 'https://test-upstash.com';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
        
        // Re-instantiate to pick up new env
        const { CacheService } = await import('../../src/services/CacheService.js');
        const cacheWithUpstash = new CacheService();
        cacheWithUpstash.stopRecoveryCheck();
        expect(cacheWithUpstash.failoverEnabled).toBe(true);

        // 3. Test failure tracking
        const error = new Error('free usage limit exceeded');
        expect(cacheWithUpstash._shouldFailover(error)).toBe(false); // 1st failure
        expect(cacheWithUpstash.failureCount).toBe(1);
        
        expect(cacheWithUpstash._shouldFailover(error)).toBe(true); // 2nd failure
        expect(cacheWithUpstash.failureCount).toBe(2);

        // 4. Test failover execution
        expect(cacheWithUpstash._failover()).toBe(true);
        expect(cacheWithUpstash.currentProvider).toBe('upstash');
        expect(cacheWithUpstash.failureCount).toBe(0);
    });

    test('should not failover if no targets available', async () => {
        // No Upstash configured in beforeEach
        const error = new Error('free usage limit exceeded');
        cache._shouldFailover(error);
        cache._shouldFailover(error);
        
        expect(cache.failoverEnabled).toBe(false);
        expect(cache._failover()).toBe(false);
        expect(cache.currentProvider).toBe('cloudflare');
    });

    test('should maintain failover state and allow recovery check', async () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://test-upstash.com';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
        
        const { CacheService } = await import('../../src/services/CacheService.js');
        const cacheWithUpstash = new CacheService();
        cacheWithUpstash.stopRecoveryCheck();

        // Trigger failover
        cacheWithUpstash._shouldFailover(new Error('429'));
        cacheWithUpstash._shouldFailover(new Error('429'));
        cacheWithUpstash._failover();

        expect(cacheWithUpstash.currentProvider).toBe('upstash');
        
        // Test recovery check start
        cacheWithUpstash.startRecoveryTimer();
        expect(cacheWithUpstash.recoveryTimer).not.toBeNull();
        cacheWithUpstash.stopRecoveryCheck();
        expect(cacheWithUpstash.recoveryTimer).toBeNull();
    });
});
