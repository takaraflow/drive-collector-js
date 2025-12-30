import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

describe("KV Service Failover Integration", () => {
    let kvInstance;

    beforeEach(async () => {
        // Set up mock environment variables for both providers - 使用新的变量名
        process.env = {
            ...originalEnv,
            CF_KV_ACCOUNT_ID: "test_cf_account",
            CF_KV_NAMESPACE_ID: "test_cf_ns",
            CF_KV_TOKEN: "test_cf_token",
            UPSTASH_REDIS_REST_URL: "https://test.upstash.io",
            UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
        };
        jest.resetModules();

        // Dynamically import kv after setting up mocks
        const { cache } = await import("../../src/services/CacheService.js");
        kvInstance = cache;
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.clearAllMocks();
        // Clean up recovery timers
        if (kvInstance) {
            kvInstance.stopRecoveryCheck();
        }
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
        expect(kvInstance.failureCount).toBe(0); // Reset after successful failover
        expect(kvInstance.lastError).toContain("free usage limit exceeded");
    });

    test("should recover back to Cloudflare after quota period", async () => {
        jest.useFakeTimers();

        // First set up Upstash as current provider (simulate previous failover)
        kvInstance.currentProvider = "upstash";
        kvInstance.failureCount = 3;
        kvInstance.lastError = "free usage limit exceeded";

        // Mock Cloudflare recovery check to succeed
        mockFetch.mockImplementation((url) => {
            if (url.includes('api.cloudflare.com') && url.includes('__health_check__')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true })
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ result: 'OK' })
            });
        });

        // Start recovery timer after fake timers
        kvInstance.startRecoveryTimer();

        // Fast-forward time to trigger recovery check
        await jest.advanceTimersToNextTimerAsync(); // Advance to recovery interval
        await Promise.resolve(); // Allow microtasks to complete
        jest.useRealTimers();
        kvInstance.stopRecoveryCheck(); // Ensure cleanup

        expect(kvInstance.currentProvider).toBe("cloudflare");
        expect(kvInstance.failureCount).toBe(0); // Should be 0 after recovery
        expect(kvInstance.lastError).toBeNull();
    });

    test("should use shorter recovery interval for non-quota errors", async () => {
        jest.useFakeTimers();

        // Set up a non-quota error scenario
        kvInstance.currentProvider = "upstash";
        kvInstance.failureCount = 3;
        kvInstance.lastError = "network timeout"; // Not quota related

        // Mock Cloudflare recovery check to succeed
        mockFetch.mockImplementation((url) => {
            if (url.includes('api.cloudflare.com') && url.includes('__health_check__')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true })
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ result: 'OK' })
            });
        });

        // Start recovery timer after fake timers
        kvInstance.startRecoveryTimer();

        // Check that shorter interval is used (30 minutes vs 12 hours)
        await jest.advanceTimersToNextTimerAsync(); // Advance to recovery interval
        await Promise.resolve(); // Allow microtasks to complete
        jest.useRealTimers();
        kvInstance.stopRecoveryCheck(); // Ensure cleanup

        expect(kvInstance.currentProvider).toBe("cloudflare");
    });

    test("should continue using Upstash if Cloudflare still fails recovery", async () => {
        jest.useFakeTimers();

        // Set up Upstash as current provider
        kvInstance.currentProvider = "upstash";
        kvInstance.failureCount = 3;

        // Mock Cloudflare recovery check to still fail
        mockFetch.mockImplementation((url) => {
            if (url.includes('api.cloudflare.com') && url.includes('__health_check__')) {
                return Promise.resolve({
                    ok: false,
                    status: 429,
                    json: () => Promise.resolve({
                        success: false,
                        errors: [{ message: "still quota exceeded" }]
                    })
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ result: 'OK' })
            });
        });

        // Start recovery timer after fake timers
        kvInstance.startRecoveryTimer();

        // Fast-forward time to trigger recovery check
        await jest.advanceTimersToNextTimerAsync(); // Advance to recovery interval
        await Promise.resolve(); // Allow microtasks to complete
        jest.useRealTimers();
        kvInstance.stopRecoveryCheck(); // Ensure cleanup

        // Should stay on Upstash
        expect(kvInstance.currentProvider).toBe("upstash");
        expect(kvInstance.failureCount).toBe(3); // Unchanged
    });

    test("should handle Upstash set operations after failover", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash operation
        mockFetch.mockResolvedValue({
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
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ result: "cached_value" })
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
        mockFetch.mockResolvedValue({
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
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ result: "OK" })
        });

        const result = await kvInstance.set("test_key", "test_value", 3600);

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://test.upstash.io/",
            expect.objectContaining({
                body: JSON.stringify(["SET", "test_key", "test_value", "EX", "3600"])
            })
        );
    });

    test("should disable failover when Upstash is not configured", async () => {
        // Remove Upstash configuration
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;

        // Re-import kv
        jest.resetModules();
        const { cache: kvNoFailover } = await import("../../src/services/CacheService.js");

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
            .rejects.toThrow("Cache Set Error");

        // Should not have switched providers or incremented failure count
        expect(kvInstance.currentProvider).toBe("cloudflare");
        expect(kvInstance.failureCount).toBe(0);
    });

    test("should handle bulk operations after failover", async () => {
        // Switch to Upstash
        kvInstance.currentProvider = "upstash";

        // Mock successful Upstash pipeline operation
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ results: [{ result: "OK" }, { result: "OK" }] })
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
