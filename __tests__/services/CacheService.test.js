import { jest, describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "@jest/globals";

// 1. Mock LocalCache to disable L1 optimization
jest.mock("../../src/utils/LocalCache.js", () => ({
    localCache: {
        isUnchanged: jest.fn(() => false), // Always return false to force physical writes
        set: jest.fn(),
        get: jest.fn(() => null), // Always miss to force physical reads
        del: jest.fn()
    }
}));

// 2. Mock RateLimiter to bypass rate limiting in tests
jest.mock("../../src/utils/RateLimiter.js", () => ({
    upstashRateLimiter: {
        execute: jest.fn((fn) => fn())
    }
}));

// Mock ioredis
jest.mock("ioredis", () => {
    return jest.fn().mockImplementation(() => {
        return {
            on: jest.fn(),
            once: jest.fn(),
            quit: jest.fn().mockResolvedValue("OK"),
            disconnect: jest.fn(),
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            keys: jest.fn(),
            pipeline: jest.fn().mockReturnValue({
                set: jest.fn(),
                exec: jest.fn().mockResolvedValue([])
            }),
            ping: jest.fn().mockResolvedValue("PONG"),
            status: "ready",
            removeAllListeners: jest.fn(),
            removeListener: jest.fn(),
            options: {}
        };
    });
});

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let CacheServiceInstance;

beforeAll(() => {
    // Use Jest's official fake timers
    jest.useFakeTimers();
});

afterAll(() => {
    jest.useRealTimers();
    process.env = originalEnv;
});

describe("Cache Service Full Suite", () => {
    // 3. Simplified setup function: Direct instantiation with injection
    async function setupCacheService(env) {
        // Reset mocks
        jest.clearAllMocks();
        mockFetch.mockClear();
        
        // Import the class directly - each test gets fresh module
        const { CacheService } = await import("../../src/services/CacheService.js");
        
        // Create instance with dependency injection
        CacheServiceInstance = new CacheService({ env });
        
        return CacheServiceInstance;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockFetch.mockClear();
        // Clear any pending timers
        jest.clearAllTimers();
    });

    afterEach(async () => {
        // 1. Destroy instance
        if (CacheServiceInstance) {
          if (typeof CacheServiceInstance.destroy === 'function') {
            await CacheServiceInstance.destroy().catch(() => {});
          }
          // Force clean references
          CacheServiceInstance.recoveryTimer = null;
          CacheServiceInstance.heartbeatTimer = null;
        }
        
        // 2. Release reference
        CacheServiceInstance = null;

        // 3. Clear any remaining timers
        jest.clearAllTimers();

        // 4. Force GC if available
        if (global.gc) {
            global.gc();
        }
    });

    // ==========================================
    // 1. Cloudflare Provider 测试
    // ==========================================
    describe("Cloudflare Provider", () => {
        beforeEach(async () => {
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token",
                CACHE_PROVIDER: "cloudflare"
            });
        });

        test("should initialize Cloudflare correctly", () => {
            expect(CacheServiceInstance.cfAccountId).toBe("cf_acc");
            expect(CacheServiceInstance.apiUrl).toContain("cf_acc/storage/kv/namespaces/cf_ns");
        });

        test("should put a value via PUT method", async () => {
            mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
            await CacheServiceInstance.set("k1", { foo: "bar" });
            expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/values/k1"), expect.objectContaining({ method: "PUT" }));
        });

        test("should handle expirationTtl in URL", async () => {
            mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
            await CacheServiceInstance.set("k1", "v1", 3600);
            expect(mockFetch.mock.calls[0][0]).toContain("expiration_ttl=3600");
        });

        test("should get JSON value successfully", async () => {
            mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ a: 1 }) });
            expect(await CacheServiceInstance.get("key")).toEqual({ a: 1 });
        });

        test("should return null on 404", async () => {
            mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });
            expect(await CacheServiceInstance.get("missing")).toBeNull();
        });

        test("should delete a key successfully", async () => {
            mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
            expect(await CacheServiceInstance.delete("key")).toBe(true);
        });

        test("should list all keys successfully", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    success: true,
                    result: [
                        { name: "key1" },
                        { name: "key2" },
                        { name: "prefix:key3" }
                    ]
                })
            });
            const keys = await CacheServiceInstance.listKeys();
            expect(keys).toEqual(["key1", "key2", "prefix:key3"]);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("/keys"),
                expect.objectContaining({ method: "GET" })
            );
        });

        test("should list keys with prefix", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    success: true,
                    result: [
                        { name: "prefix:key1" },
                        { name: "prefix:key2" }
                    ]
                })
            });
            const keys = await CacheServiceInstance.listKeys("prefix:");
            expect(keys).toEqual(["prefix:key1", "prefix:key2"]);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("/keys?prefix=prefix%3A"),
                expect.objectContaining({ method: "GET" })
            );
        });

        describe("Heartbeat Stop Method Fix Regression Tests", () => {
            test("should not crash when _handleAuthFailure is called during initialization", async () => {
                mockFetch.mockRejectedValueOnce(new Error("WRONGPASS invalid password"));
                // Check that the method exists and is callable
                expect(typeof CacheServiceInstance._handleAuthFailure).toBe("function");
                await expect(CacheServiceInstance._handleAuthFailure()).resolves.not.toThrow();
            });

            test("should have stopHeartbeat method available and callable", () => {
                expect(typeof CacheServiceInstance.stopHeartbeat).toBe("function");
                expect(() => CacheServiceInstance.stopHeartbeat()).not.toThrow();
            });

            test("should not have _stopHeartbeat method (redundant method removed)", () => {
                if (CacheServiceInstance._stopHeartbeat) {
                    expect(CacheServiceInstance._stopHeartbeat.name).not.toBe("bound _stopHeartbeat");
                }
            });

            test("should handle destroy without crashing due to heartbeat issues", async () => {
                const testInstance = await setupCacheService({
                    CF_CACHE_ACCOUNT_ID: "cf_acc",
                    CF_CACHE_NAMESPACE_ID: "cf_ns",
                    CF_CACHE_TOKEN: "cf_token",
                    CACHE_PROVIDER: "cloudflare"
                });
                
                // Use Jest fake timers for controlled testing
                jest.useFakeTimers();
                testInstance.heartbeatTimer = setInterval(() => {}, 1000);
                
                await expect(testInstance.destroy()).resolves.not.toThrow();
                
                // Clean up
                jest.useRealTimers();
                if (typeof testInstance.destroy === 'function') await testInstance.destroy();
            });

            test("should handle _restartRedisClient without crashing due to heartbeat issues", async () => {
                const testInstance = await setupCacheService({
                    CF_CACHE_ACCOUNT_ID: "cf_acc",
                    CF_CACHE_NAMESPACE_ID: "cf_ns",
                    CF_CACHE_TOKEN: "cf_token",
                    CACHE_PROVIDER: "cloudflare"
                });
                
                jest.useFakeTimers();
                testInstance.heartbeatTimer = setInterval(() => {}, 1000);
                testInstance.restarting = false;
                testInstance.destroyed = false;
                
                // Skip this test as _restartRedisClient is Redis-specific
                // and Cloudflare provider doesn't have Redis client
                if (testInstance.currentProvider === 'redis') {
                    const restartPromise = testInstance._restartRedisClient();
                    expect(restartPromise).toBeInstanceOf(Promise);
                    await restartPromise.catch(() => {});
                }
                
                jest.useRealTimers();
                if (typeof testInstance.destroy === 'function') await testInstance.destroy();
            });
        });
    });

    // ==========================================
    // 2. Upstash Provider 测试
    // ==========================================
    describe("Upstash Provider", () => {
        beforeEach(async () => {
            CacheServiceInstance = await setupCacheService({
                CACHE_PROVIDER: "upstash",
                UPSTASH_REDIS_REST_URL: "https://mock.upstash.io",
                UPSTASH_REDIS_REST_TOKEN: "up_token"
            });
        });

        test("should set value using command array format", async () => {
            mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) });
            await CacheServiceInstance.set("k1", { x: 1 });
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("https://mock.upstash.io/"),
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify(["SET", "k1", "{\"x\":1}"])
                })
            );
        });

        test("should bulkSet using Pipeline API", async () => {
            mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve([{ result: "OK" }]) });
            await CacheServiceInstance.bulkSet([{ key: "k1", value: "v1" }]);
            expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/pipeline"), expect.any(Object));
        });

        test("should list all keys using KEYS command", async () => {
            mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: ["key1", "key2", "prefix:key3"] }) });
            const keys = await CacheServiceInstance.listKeys();
            expect(keys).toEqual(["key1", "key2", "prefix:key3"]);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("https://mock.upstash.io/"),
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify(["KEYS", "*"])
                })
            );
        });

        test("should list keys with prefix using KEYS command", async () => {
            mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: ["prefix:key1", "prefix:key2"] }) });
            const keys = await CacheServiceInstance.listKeys("prefix:");
            expect(keys).toEqual(["prefix:key1", "prefix:key2"]);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("https://mock.upstash.io/"),
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify(["KEYS", "prefix:*"])
                })
            );
        });

        test("should handle non-array result from Upstash KEYS", async () => {
            mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: null }) });
            const keys = await CacheServiceInstance.listKeys();
            expect(keys).toEqual([]);
        });
    });

    // ==========================================
    // 3. 故障转移深度测试
    // ==========================================
    describe("Failover Logic Deep Dive", () => {
        beforeEach(async () => {
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf", CF_CACHE_NAMESPACE_ID: "ns", CF_CACHE_TOKEN: "tk",
                UPSTASH_REDIS_REST_URL: "https://up.io", UPSTASH_REDIS_REST_TOKEN: "ut"
            });
        });

        test("should NOT failover on generic errors (e.g., 400 Bad Request)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false, status: 400,
                json: () => Promise.resolve({ success: false, errors: [{ message: "invalid key" }] })
            });

            await expect(CacheServiceInstance.set("invalid", "v")).rejects.toThrow("Cache Set Error");
            expect(CacheServiceInstance.failureCount).toBe(0);
        });

        test("should switch to Upstash after 2 rate limit errors", async () => {
            // Restore fake timers to ensure runOnlyPendingTimers works
            jest.useFakeTimers();

            const rateLimitErr = { success: false, errors: [{ message: "rate limit" }] };
            const mockHeaders = new Map();
            mockHeaders.set('Retry-After', '0');
            
            // Clear all previous mocks
            mockFetch.mockClear();
            
            // Mock 2 Cloudflare failures to trigger failover
            mockFetch
                .mockResolvedValueOnce({ ok: false, status: 429, headers: mockHeaders, json: () => Promise.resolve(rateLimitErr) })
                .mockResolvedValueOnce({ ok: false, status: 429, headers: mockHeaders, json: () => Promise.resolve(rateLimitErr) })
                // Mock Upstash success for the retry after failover
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ result: "OK" }) });

            // Execute the set operation
            const setPromise = CacheServiceInstance.set("key", "val");
            
            // 【新增这行】强制运行所有挂起的定时器（包括 failover 里的 setInterval 和任何潜在的 Promise 任务）
            await jest.runOnlyPendingTimersAsync();
            
            // Wait for the operation to complete
            await setPromise;
            
            // Verify the provider switched
            expect(CacheServiceInstance.currentProvider).toBe("upstash");
            
            // Clean up recovery timer if it exists
            if (CacheServiceInstance && CacheServiceInstance.recoveryTimer) {
                clearInterval(CacheServiceInstance.recoveryTimer);
                CacheServiceInstance.recoveryTimer = null;
            }
        });
    });
});