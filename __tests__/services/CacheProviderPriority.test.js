import { jest, describe, test, expect, beforeEach, afterEach, beforeAll } from "@jest/globals";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock config/index.js - Only needed for the default case where no env is provided
jest.unstable_mockModule("../../src/config/index.js", () => ({
    getConfig: () => ({
        kv: {
            accountId: 'mock-cf-account-id',
            namespaceId: 'mock-cf-namespace-id',
            token: 'mock-cf-token'
        },
        redis: {},
        qstash: {},
        oss: {},
        d1: {},
        telegram: {}
    })
}));

const originalEnv = process.env;
let CacheServiceClass;

describe('CacheService Cloudflare KV Priority', () => {
    let cacheInstance;

    beforeAll(async () => {
        const module = await import("../../src/services/CacheService.js");
        CacheServiceClass = module.CacheService;
    });

    // Helper function: Create instance with specified env
    async function createCacheService(env) {
        // Re-import to ensure fresh module state
        jest.resetModules();
        const module = await import("../../src/services/CacheService.js");
        const Service = module.CacheService;
        
        const instance = new Service({ env });
        await instance.initialize();
        return instance;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockFetch.mockClear();
        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: "OK" }) });
        
        // Clear all related environment variables
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
        delete cleanEnv.CF_KV_ACCOUNT_ID;
        delete cleanEnv.CF_KV_NAMESPACE_ID;
        delete cleanEnv.CF_KV_TOKEN;
        delete cleanEnv.CF_ACCOUNT_ID;
        delete cleanEnv.UPSTASH_REDIS_REST_URL;
        delete cleanEnv.UPSTASH_REDIS_REST_TOKEN;
        process.env = cleanEnv;
    });

    afterEach(async () => {
        if (cacheInstance) {
            try {
                if (typeof cacheInstance.destroy === 'function') {
                    await cacheInstance.destroy();
                }
            } catch (error) {
                console.warn('Cleanup warning:', error.message);
            }
        }
        process.env = originalEnv;
    });

    // All Redis/Upstash tests are removed as they are obsolete
    // Current implementation only supports Cloudflare KV

    test('should use Cloudflare KV when configured via env', async () => {
        cacheInstance = await createCacheService({
            CF_CACHE_ACCOUNT_ID: 'cf-acc',
            CF_CACHE_NAMESPACE_ID: 'cf-ns',
            CF_CACHE_TOKEN: 'cf-token'
        });
        expect(cacheInstance.currentProvider).toBe('cloudflare');
        expect(cacheInstance.apiUrl).toContain('cf-acc');
    });

    test('should use Cloudflare KV when using alternative env variable names', async () => {
        cacheInstance = await createCacheService({
            CF_KV_ACCOUNT_ID: 'kv-acc',
            CF_KV_NAMESPACE_ID: 'kv-ns',
            CF_KV_TOKEN: 'kv-token'
        });
        expect(cacheInstance.currentProvider).toBe('cloudflare');
        expect(cacheInstance.apiUrl).toContain('kv-acc');
    });

    test('should use Cloudflare KV when using CF_ACCOUNT_ID fallback', async () => {
        cacheInstance = await createCacheService({
            CF_ACCOUNT_ID: 'account-acc',
            CF_KV_NAMESPACE_ID: 'account-ns',
            CF_KV_TOKEN: 'account-token'
        });
        expect(cacheInstance.currentProvider).toBe('cloudflare');
        expect(cacheInstance.apiUrl).toContain('account-acc');
    });

    test('should default to Cloudflare KV when no providers are configured (using config)', async () => {
        // When env is empty, CacheService falls back to getConfig()
        cacheInstance = await createCacheService({});
        expect(cacheInstance.currentProvider).toBe('cloudflare');
        expect(cacheInstance.apiUrl).toContain('mock-cf-account-id');
    });

    test('should fallback to memory when no Cloudflare credentials in env or config', async () => {
        // Mock getConfig to return empty kv config
        jest.resetModules();
        jest.unstable_mockModule("../../src/config/index.js", () => ({
            getConfig: () => ({
                kv: null,
                redis: {},
                qstash: {},
                oss: {},
                d1: {},
                telegram: {}
            })
        }));
        
        const module = await import("../../src/services/CacheService.js");
        const Service = module.CacheService;
        
        cacheInstance = new Service({ env: {} });
        await cacheInstance.initialize();
        
        expect(cacheInstance.currentProvider).toBe('memory');
        expect(cacheInstance.apiUrl).toBe('');
    });

    test('should prioritize env over config for Cloudflare credentials', async () => {
        cacheInstance = await createCacheService({
            CF_CACHE_ACCOUNT_ID: 'env-acc',
            CF_CACHE_NAMESPACE_ID: 'env-ns',
            CF_CACHE_TOKEN: 'env-token'
        });
        
        // Should use env values, not config values
        expect(cacheInstance.apiUrl).toContain('env-acc');
        expect(cacheInstance.apiUrl).not.toContain('mock-cf-account-id');
    });

    test('should expose correct provider status properties', async () => {
        cacheInstance = await createCacheService({
            CF_CACHE_ACCOUNT_ID: 'cf-acc',
            CF_CACHE_NAMESPACE_ID: 'cf-ns',
            CF_CACHE_TOKEN: 'cf-token'
        });

        expect(cacheInstance.currentProvider).toBe('cloudflare');
        expect(cacheInstance.hasCloudflare).toBe(true);
        expect(cacheInstance.hasRedis).toBe(false);
        expect(cacheInstance.hasUpstash).toBe(false);
        expect(cacheInstance.isFailoverMode).toBe(false);
        expect(cacheInstance.failoverEnabled).toBe(false);
        expect(cacheInstance.failureCount).toBe(0);
    });

    test('should expose correct properties in memory mode', async () => {
        cacheInstance = await createCacheService({});

        expect(cacheInstance.currentProvider).toBe('memory');
        expect(cacheInstance.hasCloudflare).toBe(false);
        expect(cacheInstance.hasRedis).toBe(false);
        expect(cacheInstance.hasUpstash).toBe(false);
        expect(cacheInstance.isFailoverMode).toBe(false);
        expect(cacheInstance.failoverEnabled).toBe(false);
        expect(cacheInstance.failureCount).toBe(0);
    });
});
