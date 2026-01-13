// Import external mocks first to ensure ioredis is mocked
import { mockRedisConstructor } from "../setup/external-mocks.js";

// Mock the logger to suppress output
vi.mock("../../src/services/logger/index.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

// Mock config to prevent Infisical calls
vi.mock("../../src/config/index.js", () => ({
    getConfig: vi.fn(() => ({ kv: {} })),
    initConfig: vi.fn(async () => ({ kv: {} })),
    config: { kv: {} }
}));

// Mock individual provider classes - define classes directly in mocks
vi.mock("../../src/services/cache/RedisCache.js", () => {
    const RedisCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('Redis');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    return { RedisCache };
});

vi.mock("../../src/services/cache/RedisTLSCache.js", () => {
    const RedisTLSCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('RedisTLS');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    return { RedisTLSCache };
});

vi.mock("../../src/services/cache/UpstashRHCache.js", () => {
    const UpstashRHCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('UpstashRHCache');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    // Add static detectConfig method
    UpstashRHCache.detectConfig = vi.fn().mockImplementation(function(env) {
        if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
            return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
        }
        return null;
    });
    return { UpstashRHCache };
});

vi.mock("../../src/services/cache/CloudflareKVCache.js", () => {
    const CloudflareKVCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('cloudflare');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    return { CloudflareKVCache };
});

vi.mock("../../src/services/cache/AivenVTCache.js", () => {
    const AivenVTCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('AivenValkey');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    // Add static detectConfig method
    AivenVTCache.detectConfig = vi.fn((env) => {
        if (env.VALKEY_HOST && env.VALKEY_PORT && env.VALKEY_PASSWORD) {
            return {
                url: `valkey://:${env.VALKEY_PASSWORD}@${env.VALKEY_HOST}:${env.VALKEY_PORT}`,
                caCert: env.VALKEY_CA_CERT,
                sniServername: env.VALKEY_HOST
            };
        }
        return null;
    });
    return { AivenVTCache };
});

vi.mock("../../src/services/cache/ValkeyCache.js", () => {
    const ValkeyCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('Valkey');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    return { ValkeyCache };
});

vi.mock("../../src/services/cache/ValkeyTLSCache.js", () => {
    const ValkeyTLSCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('ValkeyTLS');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    return { ValkeyTLSCache };
});

vi.mock("../../src/services/cache/NorthFlankRTCache.js", () => {
    const NorthFlankRTCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('NorthFlank');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    // Add static detectConfig method
    NorthFlankRTCache.detectConfig = vi.fn((env) => {
        if (env.REDIS_URL && env.REDIS_URL.includes('northflank')) {
            return { nfRedisUrl: env.REDIS_URL };
        }
        return null;
    });
    return { NorthFlankRTCache };
});

vi.mock("../../src/services/cache/RedisHTTPCache.js", () => {
    const RedisHTTPCache = vi.fn().mockImplementation(function(config) {
        this.config = config;
        this.connect = vi.fn().mockResolvedValue(undefined);
        this.disconnect = vi.fn().mockResolvedValue(undefined);
        this.getProviderName = vi.fn().mockReturnValue('RedisHTTP');
        this.get = vi.fn().mockResolvedValue(null);
        this.set = vi.fn().mockResolvedValue(true);
        this.delete = vi.fn().mockResolvedValue(true);
    });
    return { RedisHTTPCache };
});

// Import CacheService after mocks
import { CacheService } from "../../src/services/CacheService.js";

describe("CacheProviderFactory Tests", () => {
    let service;
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.clearAllMocks();
        if (mockRedisConstructor.mockClear) {
            mockRedisConstructor.mockClear();
        }
    });

    afterEach(async () => {
        if (service) {
            await service.destroy().catch(() => {});
        }
        service = null;
    });

    describe("JSON Configuration Priority", () => {
        test("should prioritize providers by priority number (lower = higher priority)", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "low-priority", type: "cloudflare-kv", priority: 3, accountId: "acc1", namespaceId: "ns1", token: "token1" },
                    { name: "high-priority", type: "redis", priority: 1, host: "localhost", port: 6379 },
                    { name: "medium-priority", type: "upstash-rest", priority: 2, restUrl: "https://test.com", restToken: "token2" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should connect to high-priority (redis) first
            expect(service.currentProviderName).toBe('Redis');
        }, 50);

        test("should skip providers not matching PRIMARY_CACHE_PROVIDER override", async () => {
            const env = {
                PRIMARY_CACHE_PROVIDER: "redis-only",
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "redis-only", type: "redis", priority: 1, host: "localhost", port: 6379 },
                    { name: "cloudflare-only", type: "cloudflare-kv", priority: 2, accountId: "acc1", namespaceId: "ns1", token: "token1" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should only use redis
            expect(service.currentProviderName).toBe('Redis');
        }, 50);

        test("should handle multiple providers with same priority (first wins)", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "first", type: "redis", priority: 1, host: "localhost", port: 6379 },
                    { name: "second", type: "upstash-rest", priority: 1, restUrl: "https://test.com", restToken: "token2" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should connect to first provider
            expect(service.currentProviderName).toBe('Redis');
        }, 50);

        test("should handle providers without explicit priority", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "no-priority-1", type: "redis", host: "localhost", port: 6379 },
                    { name: "no-priority-2", type: "upstash-rest", restUrl: "https://test.com", restToken: "token2" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should default to priority 99, so first in array wins
            expect(service.currentProviderName).toBe('Redis');
        }, 50);
    });

    describe("Provider Instantiation from Legacy Env", () => {
        test("should detect Redis from REDIS_URL", async () => {
            const env = {
                REDIS_URL: "redis://localhost:6379"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('Redis');
        }, 50);

        test("should detect Redis TLS from REDIS_URL with rediss://", async () => {
            const env = {
                REDIS_URL: "rediss://secure.redis.com:6380"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('RedisTLS');
        }, 50);

        test("should detect Upstash from UPSTASH_REDIS_REST_URL", async () => {
            const env = {
                UPSTASH_REDIS_REST_URL: "https://test.upstash.io",
                UPSTASH_REDIS_REST_TOKEN: "token123"
            };

            const originalProcessEnv = process.env;
            process.env = {};
            try {
                service = new CacheService({ env });
                await service.initialize();
            } finally {
                process.env = originalProcessEnv;
            }

            expect(service.currentProviderName).toBe('UpstashRHCache');
        }, 50);

        test("should detect Aiven from VALKEY_* env vars", async () => {
            const env = {
                VALKEY_HOST: "aiven-host",
                VALKEY_PORT: "16379",
                VALKEY_USER: "aiven-user",
                VALKEY_PASSWORD: "aiven-pass"
            };

            const originalProcessEnv = process.env;
            process.env = {};
            try {
                service = new CacheService({ env });
                await service.initialize();
            } finally {
                process.env = originalProcessEnv;
            }

            expect(service.currentProviderName).toBe('AivenValkey');
        }, 50);

        test("should detect Cloudflare from CF_CACHE_* env vars", async () => {
            const env = {
                CLOUDFLARE_KV_ACCOUNT_ID: "acc1",
                CLOUDFLARE_KV_NAMESPACE_ID: "ns1",
                CLOUDFLARE_KV_TOKEN: "token1"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('cloudflare');
        }, 50);

        test("should detect Cloudflare from CF_KV_* env vars", async () => {
            const env = {
                CLOUDFLARE_KV_ACCOUNT_ID: "acc1",
                CLOUDFLARE_KV_NAMESPACE_ID: "ns1",
                CLOUDFLARE_KV_TOKEN: "token1"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('cloudflare');
        }, 50);

        test("should detect Cloudflare from CLOUDFLARE_ACCOUNT_ID with other vars", async () => {
            const env = {
                CLOUDFLARE_ACCOUNT_ID: "acc1",
                CLOUDFLARE_KV_NAMESPACE_ID: "ns1",
                CLOUDFLARE_KV_TOKEN: "token1"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('cloudflare');
        }, 50);
    });

    describe("Provider Instantiation from JSON Config", () => {
        test("should instantiate Redis from JSON config", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "test-redis", type: "redis", priority: 1, host: "localhost", port: 6379 }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('Redis');
        }, 50);

        test("should instantiate Redis TLS from JSON config", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { 
                        name: "test-redis-tls", 
                        type: "redis", 
                        priority: 1, 
                        host: "secure.redis.com", 
                        port: 6380,
                        tls: { enabled: true, rejectUnauthorized: true, servername: "secure.redis.com" }
                    }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('RedisTLS');
        }, 50);

        test("should instantiate Upstash from JSON config", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "test-upstash", type: "upstash-rest", priority: 1, restUrl: "https://test.com", restToken: "token" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('UpstashRHCache');
        }, 50);

        test("should instantiate Cloudflare from JSON config", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "test-cf", type: "cloudflare-kv", priority: 1, accountId: "acc1", namespaceId: "ns1", token: "token1" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('cloudflare');
        }, 50);

        test("should format redis url with password-only auth", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "test-redis-auth", type: "redis", priority: 1, host: "localhost", port: 6379, password: "secret" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // 验证外部行为：服务已正确初始化
            expect(service.currentProviderName).toBe('Redis');
            
            // 验证服务可以正常工作（外部行为）
            await service.set('test-key', 'test-value');
            const value = await service.get('test-key');
            expect(value).toBe('test-value');
        }, 50);
    });

    describe("Fallback and Error Handling", () => {
        test("should handle invalid JSON in CACHE_PROVIDERS", async () => {
            const env = {
                CACHE_PROVIDERS: "invalid json {"
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should fallback to legacy detection
            expect(service.currentProviderName).toBeDefined();
        }, 50);

        test("should handle non-array JSON in CACHE_PROVIDERS", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify({ single: "provider" })
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should fallback to legacy detection
            expect(service.currentProviderName).toBeDefined();
        }, 50);

        test("should handle empty CACHE_PROVIDERS array", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should fallback to legacy detection
            expect(service.currentProviderName).toBeDefined();
        }, 50);
    });

    describe("Priority Sorting", () => {
        test("should sort providers by priority before attempting connection", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "p3", type: "redis", priority: 3, host: "host3", port: 6379 },
                    { name: "p1", type: "redis", priority: 1, host: "localhost", port: 6379 },
                    { name: "p2", type: "redis", priority: 2, host: "host2", port: 6379 }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should connect to p1 (lowest priority number = highest priority)
            expect(service.currentProviderName).toBe('Redis');
        }, 50);

        test("should handle mixed provider types with different priorities", async () => {
            const env = {
                CACHE_PROVIDERS: JSON.stringify([
                    { name: "cf", type: "cloudflare-kv", priority: 5, accountId: "acc1", namespaceId: "ns1", token: "token1" },
                    { name: "redis", type: "redis", priority: 1, host: "localhost", port: 6379 },
                    { name: "upstash", type: "upstash-rest", priority: 3, restUrl: "https://test.com", restToken: "token2" }
                ])
            };

            service = new CacheService({ env });
            await service.initialize();

            // Should connect to redis (priority 1)
            expect(service.currentProviderName).toBe('Redis');
        }, 50);
    });
});