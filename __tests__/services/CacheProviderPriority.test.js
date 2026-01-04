import { jest, describe, test, expect, beforeEach, afterEach, beforeAll } from "@jest/globals";

// 【关键修复】Mock ioredis 库
// CacheService 在检测到 Redis 环境变量时会尝试 new Redis()，如果不 Mock 会导致初始化失败或超时
jest.mock('ioredis', () => {
    return class MockRedis {
        constructor() {
            this.status = 'ready'; // 默认 ready 状态
            this.connect = jest.fn().mockResolvedValue(undefined);
            this.disconnect = jest.fn().mockResolvedValue(undefined);
            this.quit = jest.fn().mockResolvedValue(undefined);
            // 模拟常用方法
            this.get = jest.fn();
            this.set = jest.fn();
            this.del = jest.fn();
        }
    };
});

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let CacheServiceClass;

describe('CacheService Provider Priority', () => {
    let cacheInstance;

    // 【修复】在 beforeAll 中预加载模块，但在测试中通过 resetModules 重新加载
    beforeAll(async () => {
        // 预加载模块类引用
        const module = await import("../../src/services/CacheService.js");
        CacheServiceClass = module.CacheService;
    });

    // 重新加载模块的辅助函数
    async function reloadCacheService(env) {
        process.env = { ...originalEnv, ...env };
        // 【修复】使用 resetModules 清除缓存的模块实例
        jest.resetModules();
        
        // 重新导入
        const module = await import("../../src/services/CacheService.js");
        const Service = module.CacheService;
        
        return new Service();
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockFetch.mockClear();
        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: "OK" }) });
        
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
        // Check properties
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
