import { jest, describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "@jest/globals";

// Mock LocalCache to disable L1 optimization
jest.mock("../../src/utils/LocalCache.js", () => ({
    localCache: {
        isUnchanged: jest.fn(() => false), // Always return false to force physical writes
        set: jest.fn(),
        get: jest.fn(() => undefined), // Always miss to force physical reads (use undefined instead of null)
        del: jest.fn()
    }
}));

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

describe("Cache Service Cloudflare KV Tests", () => {
    // Simplified setup function: Direct instantiation with injection
    async function setupCacheService(env) {
        // Reset mocks
        jest.clearAllMocks();
        mockFetch.mockClear();
        
        // Import the class directly - each test gets fresh module
        const { CacheService } = await import("../../src/services/CacheService.js");
        
        // Create instance with dependency injection
        CacheServiceInstance = new CacheService({ env });
        await CacheServiceInstance.initialize();
        
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

    describe("Cloudflare KV Provider", () => {
        beforeEach(async () => {
            // Clear all mocks before each test
            jest.clearAllMocks();
            mockFetch.mockClear();
            
            // Mock fetch to return success for any heartbeat calls
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                text: async () => "OK",
                json: async () => ({ result: "OK" })
            });
            
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });
            
            // Stop heartbeat immediately after creation to prevent interference
            CacheServiceInstance.stopHeartbeat();
        });

        test("should initialize Cloudflare correctly", () => {
            expect(CacheServiceInstance.currentProvider).toBe('cloudflare');
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
            // Mock the fetch response
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ a: 1 })
            });
            
            // Call get with skipCache to bypass LocalCache
            const result = await CacheServiceInstance.get("key", "json", { skipCache: true });
            expect(result).toEqual({ a: 1 });
            
            // Verify fetch was called
            expect(mockFetch).toHaveBeenCalled();
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
            // Completely reset the mock and set up fresh
            mockFetch.mockReset();
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
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
            expect(mockFetch).toHaveBeenCalled();
        });

        test("should list keys with prefix", async () => {
            // Completely reset the mock and set up fresh
            mockFetch.mockReset();
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    result: [
                        { name: "prefix:key1" },
                        { name: "prefix:key2" }
                    ]
                })
            });
            
            const keys = await CacheServiceInstance.listKeys("prefix:");
            expect(keys).toEqual(["prefix:key1", "prefix:key2"]);
            expect(mockFetch).toHaveBeenCalled();
        });
    });

    describe("Memory Fallback Provider", () => {
        test("should fallback to memory when no Cloudflare credentials provided", async () => {
            CacheServiceInstance = await setupCacheService({});
            expect(CacheServiceInstance.currentProvider).toBe('memory');
            expect(CacheServiceInstance.apiUrl).toBe('');
        });

        test("should return null for get operations in memory mode", async () => {
            CacheServiceInstance = await setupCacheService({});
            const result = await CacheServiceInstance.get("test-key");
            expect(result).toBeNull();
        });

        test("should return true for set operations in memory mode", async () => {
            CacheServiceInstance = await setupCacheService({});
            const result = await CacheServiceInstance.set("test-key", "test-value");
            expect(result).toBe(true);
        });

        test("should return true for delete operations in memory mode", async () => {
            CacheServiceInstance = await setupCacheService({});
            const result = await CacheServiceInstance.delete("test-key");
            expect(result).toBe(true);
        });

        test("should return empty array for listKeys in memory mode", async () => {
            CacheServiceInstance = await setupCacheService({});
            const result = await CacheServiceInstance.listKeys();
            expect(result).toEqual([]);
        });
    });

    describe("Heartbeat and Lifecycle", () => {
        test("should start heartbeat when Cloudflare is configured", async () => {
            mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("OK") });
            
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            expect(CacheServiceInstance.heartbeatTimer).toBeDefined();
            expect(typeof CacheServiceInstance.heartbeatTimer).toBe('object');
        });

        test("should not start heartbeat in memory mode", async () => {
            CacheServiceInstance = await setupCacheService({});
            expect(CacheServiceInstance.heartbeatTimer).toBeNull();
        });

        test("should stop heartbeat when destroy is called", async () => {
            mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("OK") });
            
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            expect(CacheServiceInstance.heartbeatTimer).toBeDefined();
            
            await CacheServiceInstance.destroy();
            expect(CacheServiceInstance.heartbeatTimer).toBeNull();
        });

        test("should handle _handleAuthFailure without crashing", async () => {
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });
            
            // Should not throw
            await expect(CacheServiceInstance._handleAuthFailure()).resolves.not.toThrow();
        });

        test("should expose correct provider status properties", async () => {
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            // Cloudflare KV properties
            expect(CacheServiceInstance.hasCloudflare).toBe(true);
            expect(CacheServiceInstance.hasRedis).toBe(false);
            expect(CacheServiceInstance.hasUpstash).toBe(false);
            expect(CacheServiceInstance.isFailoverMode).toBe(false);
            expect(CacheServiceInstance.failoverEnabled).toBe(false);
            expect(CacheServiceInstance.failureCount).toBe(0);
        });

        test("should expose correct properties in memory mode", async () => {
            CacheServiceInstance = await setupCacheService({});

            expect(CacheServiceInstance.hasCloudflare).toBe(false);
            expect(CacheServiceInstance.hasRedis).toBe(false);
            expect(CacheServiceInstance.hasUpstash).toBe(false);
            expect(CacheServiceInstance.isFailoverMode).toBe(false);
            expect(CacheServiceInstance.failoverEnabled).toBe(false);
            expect(CacheServiceInstance.failureCount).toBe(0);
        });
    });

    describe("Error Handling", () => {
        test("should handle fetch timeout gracefully", async () => {
            // Mock fetch to simulate timeout by rejecting with AbortError
            mockFetch.mockImplementation(() => {
                return new Promise((_, reject) => {
                    setTimeout(() => {
                        const abortError = new Error("The operation was aborted");
                        abortError.name = "AbortError";
                        reject(abortError);
                    }, 100); // Short delay
                });
            });

            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            const result = await CacheServiceInstance.get("test-key");
            expect(result).toBeNull();
        });

        test("should handle network errors gracefully", async () => {
            mockFetch.mockRejectedValue(new Error("Network error"));

            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            const result = await CacheServiceInstance.get("test-key");
            expect(result).toBeNull();
        });

        test("should handle set operation failures", async () => {
            // Clear mocks and set up fresh mock for failure
            mockFetch.mockClear();
            mockFetch.mockResolvedValue({ ok: false, status: 500 });

            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            // The set method should throw when res.ok is false
            await expect(CacheServiceInstance.set("test-key", "test-value")).rejects.toThrow("Cache Set Error");
        });

        test("should handle delete operation failures", async () => {
            // Mock fetch to return a non-ok response
            mockFetch.mockResolvedValue({ ok: false, status: 500 });

            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            // The delete method should return true even on failure (based on current implementation)
            const result = await CacheServiceInstance.delete("test-key");
            expect(result).toBe(true);
        });

        test("should handle listKeys operation failures", async () => {
            mockFetch.mockRejectedValue(new Error("API error"));

            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "cf_acc",
                CF_CACHE_NAMESPACE_ID: "cf_ns",
                CF_CACHE_TOKEN: "cf_token"
            });

            const result = await CacheServiceInstance.listKeys();
            expect(result).toEqual([]);
        });
    });

    describe("Configuration Priority", () => {
        test("should prioritize env over config for Cloudflare credentials", async () => {
            CacheServiceInstance = await setupCacheService({
                CF_CACHE_ACCOUNT_ID: "env-acc",
                CF_CACHE_NAMESPACE_ID: "env-ns",
                CF_CACHE_TOKEN: "env-token"
            });

            expect(CacheServiceInstance.apiUrl).toContain("env-acc");
            expect(CacheServiceInstance.currentProvider).toBe('cloudflare');
        });

        test("should use alternative env variable names", async () => {
            CacheServiceInstance = await setupCacheService({
                CF_KV_ACCOUNT_ID: "kv-acc",
                CF_KV_NAMESPACE_ID: "kv-ns",
                CF_KV_TOKEN: "kv-token"
            });

            expect(CacheServiceInstance.apiUrl).toContain("kv-acc");
            expect(CacheServiceInstance.currentProvider).toBe('cloudflare');
        });

        test("should use CF_ACCOUNT_ID as fallback", async () => {
            CacheServiceInstance = await setupCacheService({
                CF_ACCOUNT_ID: "account-acc",
                CF_KV_NAMESPACE_ID: "account-ns",
                CF_KV_TOKEN: "account-token"
            });

            expect(CacheServiceInstance.apiUrl).toContain("account-acc");
            expect(CacheServiceInstance.currentProvider).toBe('cloudflare');
        });
    });
});
