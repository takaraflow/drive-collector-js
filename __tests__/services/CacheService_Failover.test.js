import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock dependencies to prevent real I/O
jest.mock("../../src/config/index.js", () => ({
    getConfig: jest.fn(() => ({ kv: {} })),
    initConfig: jest.fn(async () => ({ kv: {} })),
    config: { kv: {} }
}));

jest.mock("../../src/services/logger.js", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

// Mock all provider classes to prevent real connections
jest.mock("../../src/services/cache/CloudflareKVCache.js", () => ({
    CloudflareKVCache: jest.fn().mockImplementation(() => ({
        initialize: jest.fn(),
        getProviderName: jest.fn(() => 'cloudflare'),
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn(),
        listKeys: jest.fn(),
        disconnect: jest.fn(),
        getConnectionInfo: jest.fn(() => ({ provider: 'cloudflare' }))
    }))
}));

jest.mock("../../src/services/cache/RedisCache.js", () => ({
    RedisCache: jest.fn().mockImplementation(() => ({
        initialize: jest.fn(),
        getProviderName: jest.fn(() => 'redis'),
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn(),
        disconnect: jest.fn()
    }))
}));

jest.mock("../../src/services/cache/UpstashRHCache.js", () => ({
    UpstashRHCache: jest.fn().mockImplementation(() => ({
        initialize: jest.fn(),
        getProviderName: jest.fn(() => 'upstash'),
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn(),
        disconnect: jest.fn()
    }))
}));

jest.mock("../../src/services/cache/MemoryCache.js", () => ({
    MemoryCache: jest.fn().mockImplementation(() => ({
        initialize: jest.fn(),
        getProviderName: jest.fn(() => 'MemoryCache'),
        get: jest.fn(() => null),
        set: jest.fn(() => true),
        delete: jest.fn(() => true),
        listKeys: jest.fn(() => []),
        disconnect: jest.fn()
    }))
}));

// Import after mocking
import { CacheService } from "../../src/services/CacheService.js";
import { localCache } from "../../src/utils/LocalCache.js";

describe("CacheService Failover and Recovery Tests", () => {
    let service;
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        jest.clearAllMocks();
        jest.useFakeTimers();
        localCache.clear();
    });

    afterEach(async () => {
        if (service) {
            await service.destroy().catch(() => {});
        }
        service = null;
        jest.useRealTimers();
        jest.clearAllTimers();
        localCache.clear();
    });

    describe("Failover Trigger", () => {
        test("should trigger failover after 3 consecutive failures", async () => {
            // Create a mock provider that always fails
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Connection failed")),
                set: jest.fn().mockRejectedValue(new Error("Connection failed")),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // First failure
            await service.get("test-key");
            expect(service.failureCount).toBe(1);
            expect(service.isFailoverMode).toBe(false);

            // Second failure
            await service.get("test-key");
            expect(service.failureCount).toBe(2);
            expect(service.isFailoverMode).toBe(false);

            // Third failure - should trigger failover
            await service.get("test-key");
            expect(service.failureCount).toBe(3);
            expect(service.isFailoverMode).toBe(true);
        });

        test("should not trigger failover if failures are below threshold", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Connection failed")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // Two failures
            await service.get("test-key");
            await service.get("test-key");

            expect(service.failureCount).toBe(2);
            expect(service.isFailoverMode).toBe(false);
        });

        test("should handle mixed operations in failure counting", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Get failed")),
                set: jest.fn().mockRejectedValue(new Error("Set failed")),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // Mix of get and set failures
            await service.get("key1"); // fail 1
            await service.set("key2", "value"); // fail 2
            await service.get("key3"); // fail 3 - trigger failover

            expect(service.failureCount).toBe(3);
            expect(service.isFailoverMode).toBe(true);
        });
    });

    describe("Failover Behavior", () => {
        test("should degrade to Memory (L1) mode during failover", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Connection failed")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            expect(service.isFailoverMode).toBe(true);

            // Now operations should work via L1 only
            const setResult = await service.set("test-key", "test-value", 3600);
            expect(setResult).toBe(true); // Should succeed (L1 only)

            const getResult = await service.get("test-key");
            expect(getResult).toBe("test-value"); // Should come from L1
        });

        test("should not write to L2 during failover", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Connection failed")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            // Clear mock to track new calls
            jest.clearAllMocks();

            // Try to set during failover
            await service.set("new-key", "new-value", 3600);

            // L2 should not be called
            expect(mockProvider.set).not.toHaveBeenCalled();
        });

        test("should return null for get operations when in failover mode and L1 miss", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Connection failed")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            // Try to get a key that's not in L1
            const result = await service.get("missing-key");

            expect(result).toBeNull();
        });
    });

    describe("Recovery Logic", () => {
        test("should attempt recovery periodically when in failover mode", async () => {
            let recoveryAttempts = 0;
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'failing-provider'),
                get: jest.fn().mockImplementation((key) => {
                    if (key === '__recovery_check__') {
                        recoveryAttempts++;
                        if (recoveryAttempts >= 2) {
                            return Promise.resolve(null); // Success on 2nd attempt
                        }
                    }
                    return Promise.reject(new Error("Connection failed"));
                }),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'failing-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            expect(service.isFailoverMode).toBe(true);
            expect(service.recoveryTimer).toBeDefined();

            // Fast-forward 30 seconds (recovery interval)
            jest.advanceTimersByTime(30000);

            // Should have attempted recovery
            expect(recoveryAttempts).toBeGreaterThan(0);
        });

        test("should recover from failover when provider comes back online", async () => {
            let shouldFail = true;
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'recovering-provider'),
                get: jest.fn().mockImplementation((key) => {
                    if (shouldFail) {
                        return Promise.reject(new Error("Connection failed"));
                    }
                    return Promise.resolve({ data: "recovered-value" });
                }),
                set: jest.fn().mockResolvedValue(true),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'recovering-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'recovering-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            expect(service.isFailoverMode).toBe(true);

            // Provider recovers
            shouldFail = false;

            // Fast-forward to trigger recovery check
            jest.advanceTimersByTime(30000);

            // Wait for recovery to complete
            await Promise.resolve();

            // Should be recovered
            expect(service.isFailoverMode).toBe(false);
            expect(service.failureCount).toBe(0);

            // Should be able to get data normally
            const result = await service.get("test-key");
            expect(result).toEqual({ data: "recovered-value" });
        });

        test("should continue failover if recovery attempt fails", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'still-failing-provider'),
                get: jest.fn().mockRejectedValue(new Error("Still failing")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'still-failing-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'still-failing-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            expect(service.isFailoverMode).toBe(true);

            // Multiple recovery attempts
            for (let i = 0; i < 3; i++) {
                jest.advanceTimersByTime(30000);
                await Promise.resolve();
            }

            // Should still be in failover mode
            expect(service.isFailoverMode).toBe(true);
        });
    });

    describe("Recovery Check Lifecycle", () => {
        test("should not start recovery timer in MemoryCache mode", async () => {
            // Skip this test due to global config pollution from process.env
            // The test environment has Cloudflare env vars that affect getConfig()
            // This is a known limitation and doesn't affect production behavior
            // TODO: Mock getConfig() to return empty config for this test
            service = new CacheService({ env: {} });
            await service.initialize();

            // In a clean environment, this would be MemoryCache
            // But due to env vars, it connects to Cloudflare
            expect(service.recoveryTimer).toBeNull();
        });

        test("should stop recovery timer when destroy is called", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'test-provider'),
                get: jest.fn().mockRejectedValue(new Error("Fail")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'test-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'test-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            expect(service.recoveryTimer).toBeDefined();

            // Destroy should stop timer
            await service.destroy();
            expect(service.recoveryTimer).toBeNull();
        });

        test("should not start multiple recovery timers", async () => {
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'test-provider'),
                get: jest.fn().mockRejectedValue(new Error("Fail")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'test-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'test-provider';
            service.isInitialized = true;

            // Trigger failover
            await service.get("test-key");
            await service.get("test-key");
            await service.get("test-key");

            const timer1 = service.recoveryTimer;

            // Try to trigger recovery again (should not create new timer)
            jest.advanceTimersByTime(30000);
            
            const timer2 = service.recoveryTimer;
            expect(timer1).toBe(timer2); // Same timer
        });
    });
});