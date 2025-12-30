import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;

describe("CacheService Optimization", () => {
    let cache;
    let localCache;

    beforeAll(async () => {
        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "test_account",
            CF_KV_NAMESPACE_ID: "test_namespace",
            CF_KV_TOKEN: "test_token",
        };

        // Re-import to ensure env vars are picked up
        jest.resetModules();
        const cacheModule = await import("../../src/services/CacheService.js");
        cache = cacheModule.cache;
        const localCacheModule = await import("../../src/utils/LocalCache.js");
        localCache = localCacheModule.localCache;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        localCache.clear();
        // 缩短 L1 TTL 方便测试
        cache.l1CacheTtl = 1000;
    });

    describe("Read Cache (L1)", () => {
        test("should only call fetch once for multiple gets of the same key", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve("cached_value"),
                text: () => Promise.resolve("cached_value")
            });

            // First call - should trigger fetch
            const val1 = await cache.get("test_key", "text");
            expect(val1).toBe("cached_value");
            expect(mockFetch).toHaveBeenCalledTimes(1);

            // Second call - should return from L1 cache
            const val2 = await cache.get("test_key", "text");
            expect(val2).toBe("cached_value");
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("should bypass cache when skipCache is true", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve("fresh_value"),
                text: () => Promise.resolve("fresh_value")
            });

            // First call to populate cache
            await cache.get("test_key", "text");
            expect(mockFetch).toHaveBeenCalledTimes(1);

            // Second call with skipCache
            const val = await cache.get("test_key", "text", { skipCache: true });
            expect(val).toBe("fresh_value");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        test("should respect custom cacheTtl", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve("value"),
                text: () => Promise.resolve("value")
            });

            await cache.get("test_key", "text", { cacheTtl: 20 });
            expect(mockFetch).toHaveBeenCalledTimes(1);

            await new Promise(r => setTimeout(r, 25)); // 等待超过缓存TTL

            await cache.get("test_key", "text");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe("Write Optimization (Smart Filtering)", () => {
        test("should skip physical set if value is unchanged in cache", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true })
            });

            await cache.set("test_key", "same_value");
            expect(mockFetch).toHaveBeenCalledTimes(1);

            const result = await cache.set("test_key", "same_value");
            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("should trigger physical set if value changes", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true })
            });

            await cache.set("test_key", "old_value");
            expect(mockFetch).toHaveBeenCalledTimes(1);

            await cache.set("test_key", "new_value");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        test("should trigger physical set if cache expired", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true })
            });

            cache.l1CacheTtl = 20; // 优化：减少缓存TTL
            await cache.set("test_key", "value");
            expect(mockFetch).toHaveBeenCalledTimes(1);

            await new Promise(r => setTimeout(r, 30)); // 优化：减少等待时间

            await cache.set("test_key", "value");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        test("should bypass write filtering when skipCache is true", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true })
            });

            await cache.set("test_key", "value");
            expect(mockFetch).toHaveBeenCalledTimes(1);

            await cache.set("test_key", "value", null, { skipCache: true });
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe("Delete Logic", () => {
        test("should clear L1 cache on delete", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve("value"),
                text: () => Promise.resolve("value")
            });

            await cache.get("test_key", "text");
            
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true })
            });
            await cache.delete("test_key");

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve("new_value"),
                text: () => Promise.resolve("new_value")
            });
            await cache.get("test_key", "text");
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });
    });
});