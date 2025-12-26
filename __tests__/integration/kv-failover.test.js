import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

describe("KV Service Failover Integration", () => {
    let kvInstance;

    beforeEach(async () => {
        // Set up mock environment variables for both providers
        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "test_cf_account",
            CF_KV_NAMESPACE_ID: "test_cf_ns",
            CF_KV_TOKEN: "test_cf_token",
            UPSTASH_REDIS_REST_URL: "https://test.upstash.io",
            UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
        };
        jest.resetModules();

        // Dynamically import kv after setting up mocks
        const { kv: importedKV } = await import("../../src/services/kv.js");
        kvInstance = importedKV;
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.clearAllMocks();
    });

    test("should start with Cloudflare as primary provider", () => {
        expect(kvInstance.currentProvider).toBe("cloudflare");
        expect(kvInstance.hasUpstash).toBe(true);
        expect(kvInstance.failoverEnabled).toBe(true);
    });

    test("should switch to Upstash after quota exceeded errors", async () => {
        // Mock Cloudflare to return quota exceeded 3 times
        mockFetch
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                json: () => Promise.resolve({
                    success: false,
                    errors: [{ message: "free usage limit exceeded" }]
                })
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                json: () => Promise.resolve({
                    success: false,
                    errors: [{ message: "free usage limit exceeded" }]
                })
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                json: () => Promise.resolve({
                    success: false,
                    errors: [{ message: "free usage limit exceeded" }]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ result: "OK" })
            });

        // First call should trigger failover
        await kvInstance.set("test_key", "test_value");

        expect(kvInstance.currentProvider).toBe("upstash");
        expect(kvInstance.failureCount).toBe(3);
        expect(kvInstance.lastError).toContain("free usage limit exceeded");
    });

    test("should recover back to Cloudflare after quota period", async () => {
        // First set up Upstash as current provider (simulate previous failover)
        kvInstance.currentProvider = "upstash";
        kvInstance.failureCount = 3;
        kvInstance.lastError = "free usage limit exceeded";

        // Start recovery timer
        kvInstance.startRecoveryTimer();

        // Mock Cloudflare recovery check to succeed
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ success: true })
        });

        // Fast-forward time to trigger recovery check
        jest.useFakeTimers();
        await jest.advanceTimersByTimeAsync(13 * 60 * 60 * 1000); // 13 hours (quota period)
        jest.useRealTimers();

        expect(kvInstance.currentProvider).toBe("cloudflare");
        expect(kvInstance.failureCount).toBe(0);
        expect(kvInstance.lastError).toBeNull();
    });

    test("should use shorter recovery interval for non-quota errors", async () => {
        // Set up a non-quota error scenario
        kvInstance.currentProvider = "upstash";
        kvInstance.failureCount = 3;
        kvInstance.lastError = "network timeout"; // Not quota related

        // Start recovery timer
        kvInstance.startRecoveryTimer();

        // Mock Cloudflare recovery check to succeed
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ success: true })
        });

        // Check that shorter interval is used (30 minutes vs 12 hours)
        jest.useFakeTimers();
        await jest.advanceTimersByTimeAsync(31 * 60 * 1000); // 31 minutes
        jest.useRealTimers();

        expect(kvInstance.currentProvider).toBe("cloudflare");
    });

    test("should continue using Upstash if Cloudflare still fails recovery", async () => {
        // Set up Upstash as current provider
        kvInstance.currentProvider = "upstash";
        kvInstance.failureCount = 3;

        // Start recovery timer
        kvInstance.startRecoveryTimer();

        // Mock Cloudflare recovery check to still fail
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
            json: () => Promise.resolve({
                success: false,
                errors: [{ message: "still quota exceeded" }]
            })
        });

        // Fast-forward time to trigger recovery check
        jest.useFakeTimers();
        await jest.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);
        jest.useRealTimers();

        // Should stay on Upstash
        expect(kvInstance.currentProvider).toBe("upstash");
        expect(kvInstance.failureCount).toBe(3); // Unchanged
    });

    test("should handle Upstash set operations after failover", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash operation
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ result: "OK" })
        });

        const result = await kvInstance.set("test_key", { complex: "object", with: "nested data" });

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://test.upstash.io/",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify(["SET", "test_key", "{\"complex\":\"object\",\"with\":\"nested data\"}"])
            })
        );
    });

    test("should handle Upstash get operations after failover", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash get operation
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ result: "\"cached_value\"" })
        });

        const result = await kvInstance.get("test_key");

        expect(result).toBe("cached_value");
        expect(mockFetch).toHaveBeenCalledWith(
            "https://test.upstash.io/get/test_key",
            expect.any(Object)
        );
    });

    test("should handle Upstash delete operations after failover", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash delete operation
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ result: 1 })
        });

        const result = await kvInstance.delete("test_key");

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://test.upstash.io/del/test_key",
            expect.any(Object)
        );
    });

    test("should handle TTL in Upstash set operations", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash operation with TTL
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ result: "OK" })
        });

        const result = await kvInstance.set("test_key", "test_value", 3600);

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://test.upstash.io/",
            expect.objectContaining({
                body: JSON.stringify(["SET", "test_key", "\"test_value\"", "EX", "3600"])
            })
        );
    });

    test("should disable failover when Upstash is not configured", async () => {
        // Remove Upstash configuration
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;

        // Re-import kv
        jest.resetModules();
        const { kv: kvNoFailover } = await import("../../src/services/kv.js");

        expect(kvNoFailover.failoverEnabled).toBe(false);
        expect(kvNoFailover.hasUpstash).toBe(false);
    });

    test("should not failover on non-quota errors", async () => {
        // Mock Cloudflare to return non-quota errors (should not trigger failover)
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: () => Promise.resolve({
                success: false,
                errors: [{ message: "invalid key" }]
            })
        });

        await expect(kvInstance.set("invalid key", "value"))
            .rejects.toThrow("KV Set Error");

        // Should not have switched providers or incremented failure count
        expect(kvInstance.currentProvider).toBe("cloudflare");
        expect(kvInstance.failureCount).toBe(0);
    });

    test("should handle bulk operations after failover", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash pipeline operation
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve([{ result: "OK" }, { result: "OK" }])
        });

        const result = await kvInstance.bulkSet([
            { key: "key1", value: "value1" },
            { key: "key2", value: "value2" }
        ]);

        expect(result).toEqual([
            { success: true, result: "OK" },
            { success: true, result: "OK" }
        ]);
    });
});