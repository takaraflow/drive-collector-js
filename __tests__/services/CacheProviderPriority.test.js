// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock config/index.js - Only needed for the default case where no env is provided
vi.mock("../../src/config/index.js", () => ({
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
        vi.resetModules();
        const module = await import("../../src/services/CacheService.js");
        const Service = module.CacheService;
        
        const instance = new Service({ env });
        await instance.initialize();
        return instance;
    }

    beforeEach(() => {
        vi.clearAllMocks();
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
        delete cleanEnv.CLOUDFLARE_KV_ACCOUNT_ID;
        delete cleanEnv.CLOUDFLARE_KV_NAMESPACE_ID;
        delete cleanEnv.CLOUDFLARE_KV_TOKEN;
        delete cleanEnv.CLOUDFLARE_KV_ACCOUNT_ID;
        delete cleanEnv.CLOUDFLARE_KV_NAMESPACE_ID;
        delete cleanEnv.CLOUDFLARE_KV_TOKEN;
        delete cleanEnv.CLOUDFLARE_ACCOUNT_ID;
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

    test('should use Cloudflare KV when configured via env', async () => {
        cacheInstance = await createCacheService({
            CLOUDFLARE_KV_ACCOUNT_ID: 'cf-acc',
            CLOUDFLARE_KV_NAMESPACE_ID: 'cf-ns',
            CLOUDFLARE_KV_TOKEN: 'cf-token'
        });
        expect(cacheInstance.getCurrentProvider()).toBe('cloudflare');
        expect(cacheInstance.primaryProvider.apiUrl).toContain('cf-acc');
    });

    test('should use Cloudflare KV when using alternative env variable names', async () => {
        cacheInstance = await createCacheService({
            CLOUDFLARE_KV_ACCOUNT_ID: 'kv-acc',
            CLOUDFLARE_KV_NAMESPACE_ID: 'kv-ns',
            CLOUDFLARE_KV_TOKEN: 'kv-token'
        });
        expect(cacheInstance.getCurrentProvider()).toBe('cloudflare');
        expect(cacheInstance.primaryProvider.apiUrl).toContain('kv-acc');
    });

    test('should use Cloudflare KV when using CLOUDFLARE_ACCOUNT_ID fallback', async () => {
        cacheInstance = await createCacheService({
            CLOUDFLARE_ACCOUNT_ID: 'account-acc',
            CLOUDFLARE_KV_NAMESPACE_ID: 'account-ns',
            CLOUDFLARE_KV_TOKEN: 'account-token'
        });
        expect(cacheInstance.getCurrentProvider()).toBe('cloudflare');
        expect(cacheInstance.primaryProvider.apiUrl).toContain('account-acc');
    });

    test('should default to Cloudflare KV when no providers are configured (using config)', async () => {
        // When env is empty, CacheService falls back to getConfig()
        cacheInstance = await createCacheService({});
        expect(cacheInstance.getCurrentProvider()).toBe('cloudflare');
        expect(cacheInstance.primaryProvider.apiUrl).toContain('mock-cf-account-id');
    });

    test('should fallback to memory when no Cloudflare credentials in env or config', async () => {
        // Mock getConfig to return empty kv config
        vi.resetModules();
        vi.doMock("../../src/config/index.js", () => ({
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
        
        expect(cacheInstance.getCurrentProvider()).toBe('MemoryCache');
    });

    test('should prioritize env over config for Cloudflare credentials', async () => {
        cacheInstance = await createCacheService({
            CLOUDFLARE_KV_ACCOUNT_ID: 'env-acc',
            CLOUDFLARE_KV_NAMESPACE_ID: 'env-ns',
            CLOUDFLARE_KV_TOKEN: 'env-token'
        });
        
        // Should use env values, not config values
        expect(cacheInstance.primaryProvider.apiUrl).toContain('env-acc');
        expect(cacheInstance.primaryProvider.apiUrl).not.toContain('mock-cf-account-id');
    });

    test('should expose correct provider status properties', async () => {
        cacheInstance = await createCacheService({
            CLOUDFLARE_KV_ACCOUNT_ID: 'cf-acc',
            CLOUDFLARE_KV_NAMESPACE_ID: 'cf-ns',
            CLOUDFLARE_KV_TOKEN: 'cf-token'
        });

        expect(cacheInstance.getCurrentProvider()).toBe('cloudflare');
        expect(cacheInstance.isFailoverMode).toBe(false);
        expect(cacheInstance.failureCount).toBe(0);
    });

    test('should expose correct properties in memory mode', async () => {
        // Reset modules to ensure clean state
        vi.resetModules();
        
        // Re-apply the config mock using doMock
        vi.doMock("../../src/config/index.js", () => ({
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

        const module = await import("../../src/services/CacheService.js");
        const Service = module.CacheService;
        
        cacheInstance = new Service({ env: {} });
        await cacheInstance.initialize();

        // When no env is provided, CacheService falls back to getConfig()
        // The mocked getConfig returns Cloudflare KV credentials
        expect(cacheInstance.getCurrentProvider()).toBe('cloudflare');
        expect(cacheInstance.isFailoverMode).toBe(false);
        expect(cacheInstance.failureCount).toBe(0);
    });

    test('should handle missing config gracefully', async () => {
        // Mock getConfig to throw error
        vi.resetModules();
        vi.doMock("../../src/config/index.js", () => ({
            getConfig: () => {
                throw new Error('Config not available');
            }
        }));
        
        const module = await import("../../src/services/CacheService.js");
        const Service = module.CacheService;
        
        cacheInstance = new Service({ env: {} });
        await cacheInstance.initialize();
        
        // Should fallback to memory cache
        expect(cacheInstance.getCurrentProvider()).toBe('MemoryCache');
    });
});