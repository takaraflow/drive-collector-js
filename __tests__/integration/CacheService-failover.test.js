import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { CacheService } from "../../src/services/CacheService.js";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock the logger
jest.mock('../../src/services/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe("KV Service Failover Integration - Optimized", () => {
    let kvInstance;
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.CF_KV_ACCOUNT_ID = "test_cf_account";
        process.env.CF_KV_NAMESPACE_ID = "test_cf_ns";
        process.env.CF_KV_TOKEN = "test_cf_token";
        process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
        process.env.UPSTASH_REDIS_REST_TOKEN = "test_upstash_token";
        
        kvInstance = new CacheService();
        kvInstance.stopRecoveryCheck();
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env = originalEnv;
        if (kvInstance) kvInstance.stopRecoveryCheck();
    });

    test("should handle full failover lifecycle", async () => {
        // 1. Initial state
        expect(kvInstance.currentProvider).toBe("cloudflare");

        // 2. Trigger failover with 2 quota errors
        mockFetch
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                json: async () => ({ success: false, errors: [{ message: "free usage limit exceeded" }] })
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                json: async () => ({ success: false, errors: [{ message: "free usage limit exceeded" }] })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ result: "OK" })
            });

        await kvInstance.set("test_key", "test_value");
        expect(kvInstance.currentProvider).toBe("upstash");

        // 3. Verify Upstash operations (Combined to save time)
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ result: "cached_value" })
        });
        
        const getResult = await kvInstance.get("test_key", "json", { skipCache: true });
        expect(getResult).toBe("cached_value");
        
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ result: 1 })
        });
        const delResult = await kvInstance.delete("test_key");
        expect(delResult).toBe(true);
    });

    test("should handle recovery scenarios", async () => {
        jest.useFakeTimers();
        
        kvInstance.currentProvider = "upstash";
        kvInstance.lastError = "free usage limit exceeded";

        mockFetch.mockImplementation(async (url) => {
            if (url.includes('api.cloudflare.com') && url.includes('__health_check__')) {
                return { ok: true, json: async () => ({ success: true }) };
            }
            return { ok: true, json: async () => ({ result: 'OK' }) };
        });

        kvInstance.startRecoveryTimer();
        await jest.advanceTimersToNextTimerAsync();
        
        expect(kvInstance.currentProvider).toBe("cloudflare");
        
        jest.useRealTimers();
    });

    test("should handle non-failover errors and configuration changes", async () => {
        // 1. Non-quota error
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ success: false, errors: [{ message: "invalid key" }] })
        });

        await expect(kvInstance.set("invalid key", "value")).rejects.toThrow();
        expect(kvInstance.currentProvider).toBe("cloudflare");

        // 2. No failover when Upstash missing
        delete process.env.UPSTASH_REDIS_REST_URL;
        const kvNoUpstash = new CacheService();
        expect(kvNoUpstash.failoverEnabled).toBe(false);
    });
});
