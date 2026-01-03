import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;

describe('CacheService Provider Priority', () => {
    let cacheInstance;

    async function reloadCacheService(env) {
        process.env = { ...originalEnv, ...env };
        // 使用查询字符串参数绕过 ESM 模块缓存
        const { CacheService } = await import(`../../src/services/CacheService.js?t=${Date.now()}`);
        return new CacheService();
    }

    beforeEach(() => {
        jest.clearAllMocks();
        // 清除所有相关的环境变量
        const cleanEnv = { ...originalEnv };
        delete cleanEnv.CACHE_PROVIDER;
        delete cleanEnv.KV_PROVIDER;
        delete cleanEnv.NF_REDIS_URL;
        delete cleanEnv.NF_REDIS_HOST;
        delete cleanEnv.NF_REDIS_PORT;
        delete cleanEnv.REDIS_URL;
        delete cleanEnv.REDIS_HOST;
        delete cleanEnv.REDIS_PORT;
        delete cleanEnv.CF_CACHE_ACCOUNT_ID;
        delete cleanEnv.CF_CACHE_NAMESPACE_ID;
        delete cleanEnv.CF_CACHE_TOKEN;
        delete cleanEnv.UPSTASH_REDIS_REST_URL;
        delete cleanEnv.UPSTASH_REDIS_REST_TOKEN;
        process.env = cleanEnv;
    });

    afterEach(async () => {
        if (cacheInstance) {
            try {
                // 清理所有可能的定时器
                if (cacheInstance.recoveryTimer) {
                    clearInterval(cacheInstance.recoveryTimer);
                }
                
                // 安全调用 destroy
                if (typeof cacheInstance.destroy === 'function') {
                    await cacheInstance.destroy();
                }
            } catch (error) {
                // 防止清理时报错影响测试结果
                console.warn('Cleanup warning:', error.message);
            }
        }
        process.env = originalEnv;
    });

    test('should prioritize NF Redis over CF KV and Upstash', async () => {
        cacheInstance = await reloadCacheService({
            NF_REDIS_HOST: 'redis.example.com',
            NF_REDIS_PORT: '6379',
            CF_CACHE_ACCOUNT_ID: 'cf-acc',
            CF_CACHE_NAMESPACE_ID: 'cf-ns',
            CF_CACHE_TOKEN: 'cf-token',
            UPSTASH_REDIS_REST_URL: 'https://upstash.io',
            UPSTASH_REDIS_REST_TOKEN: 'up-token'
        });
        expect(cacheInstance.hasRedis).toBe(true);
        expect(cacheInstance.currentProvider).toBe('redis');
    });

    test('should prioritize CF KV over Upstash when Redis is not configured', async () => {
        cacheInstance = await reloadCacheService({
            CF_CACHE_ACCOUNT_ID: 'cf-acc',
            CF_CACHE_NAMESPACE_ID: 'cf-ns',
            CF_CACHE_TOKEN: 'cf-token',
            UPSTASH_REDIS_REST_URL: 'https://upstash.io',
            UPSTASH_REDIS_REST_TOKEN: 'up-token'
        });
        expect(cacheInstance.hasRedis).toBe(false);
        expect(cacheInstance.hasCloudflare).toBe(true);
        expect(cacheInstance.currentProvider).toBe('cloudflare');
    });

    test('should fallback to Upstash when only Upstash is configured', async () => {
        cacheInstance = await reloadCacheService({
            UPSTASH_REDIS_REST_URL: 'https://upstash.io',
            UPSTASH_REDIS_REST_TOKEN: 'up-token'
        });
        expect(cacheInstance.hasRedis).toBe(false);
        expect(cacheInstance.hasCloudflare).toBe(false);
        expect(cacheInstance.hasUpstash).toBe(true);
        expect(cacheInstance.currentProvider).toBe('upstash');
    });

    test('should default to CF KV when no providers are configured', async () => {
        cacheInstance = await reloadCacheService({});
        expect(cacheInstance.currentProvider).toBe('cloudflare');
    });

    test('should honor CACHE_PROVIDER override', async () => {
        cacheInstance = await reloadCacheService({
            NF_REDIS_HOST: 'redis.example.com',
            CF_CACHE_ACCOUNT_ID: 'cf-acc',
            UPSTASH_REDIS_REST_URL: 'https://upstash.io',
            CACHE_PROVIDER: 'upstash',
            UPSTASH_REDIS_REST_TOKEN: 'up-token'
        });
        expect(cacheInstance.currentProvider).toBe('upstash');
    });
});
