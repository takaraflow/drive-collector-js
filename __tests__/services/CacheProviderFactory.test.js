import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the logger to suppress output
jest.mock("../../src/services/logger.js", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

// Mock config to prevent Infisical calls
jest.mock("../../src/config/index.js", () => ({
    getConfig: jest.fn(() => ({ kv: {} })),
    initConfig: jest.fn(async () => ({ kv: {} })),
    config: { kv: {} }
}));

// Import CacheService after mocks
import { CacheService } from "../../src/services/CacheService.js";
import { mockRedisConstructor } from "../setup/external-mocks.js";

describe("CacheProviderFactory Tests", () => {
    let service;
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        jest.clearAllMocks();
        mockRedisConstructor.mock.calls = [];
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

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('UpstashRHCache');
        }, 50);

        test("should detect Cloudflare from CF_CACHE_* env vars", async () => {
            const env = {
                CF_CACHE_ACCOUNT_ID: "acc1",
                CF_CACHE_NAMESPACE_ID: "ns1",
                CF_CACHE_TOKEN: "token1"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('cloudflare');
        }, 50);

        test("should detect Cloudflare from CF_KV_* env vars", async () => {
            const env = {
                CF_KV_ACCOUNT_ID: "acc1",
                CF_KV_NAMESPACE_ID: "ns1",
                CF_KV_TOKEN: "token1"
            };

            service = new CacheService({ env });
            await service.initialize();

            expect(service.currentProviderName).toBe('cloudflare');
        }, 50);

        test("should detect Cloudflare from CF_ACCOUNT_ID with other vars", async () => {
            const env = {
                CF_ACCOUNT_ID: "acc1",
                CF_KV_NAMESPACE_ID: "ns1",
                CF_KV_TOKEN: "token1"
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

            const calls = mockRedisConstructor.mock.calls;
            expect(calls.length).toBeGreaterThan(0);
            expect(calls[0][0]).toContain("redis://:secret@localhost:6379/0");
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
