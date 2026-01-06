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

describe("CacheService L1/L2 Interaction Tests", () => {
    let service;
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        jest.clearAllMocks();
        jest.useFakeTimers();
        // Clear LocalCache before each test
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

    describe("L1/L2 Interaction", () => {
        test("L1 miss should trigger L2 read and populate L1", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn().mockResolvedValue({ data: "cached-value" }),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';
            service.isInitialized = true;

            // Execute - L1 miss (key not in cache)
            const result = await service.get("test-key");

            // Verify L2 was called
            expect(mockProvider.get).toHaveBeenCalledWith("test-key", "json");
            
            // Verify result
            expect(result).toEqual({ data: "cached-value" });
            
            // Verify L1 was populated by checking subsequent call returns from L1
            const result2 = await service.get("test-key");
            expect(mockProvider.get).toHaveBeenCalledTimes(1); // Still only 1 call, second came from L1
            expect(result2).toEqual({ data: "cached-value" });
        });

        test("L1 hit should return immediately without L2 call", async () => {
            // Pre-populate L1
            localCache.set("test-key", { data: "l1-value" }, 10000);

            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn().mockResolvedValue({ data: "should-not-be-called" }),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute
            const result = await service.get("test-key");

            // Verify L2 was NOT called
            expect(mockProvider.get).not.toHaveBeenCalled();
            
            // Verify result from L1
            expect(result).toEqual({ data: "l1-value" });
        });

        test("skipL1 option bypasses L1 and reads from L2", async () => {
            // Pre-populate L1 with different value
            localCache.set("test-key", { data: "l1-value" }, 10000);

            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn().mockResolvedValue({ data: "l2-value" }),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute with skipL1
            const result = await service.get("test-key", "json", { skipL1: true });

            // Verify L2 was called
            expect(mockProvider.get).toHaveBeenCalledWith("test-key", "json");
            
            // Verify result from L2 (not L1)
            expect(result).toEqual({ data: "l2-value" });
        });

        test("L2 write should also update L1 (write-through to L1)", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn(),
                set: jest.fn().mockResolvedValue(true),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute
            await service.set("test-key", { data: "new-value" }, 3600);

            // Verify L2 was called
            expect(mockProvider.set).toHaveBeenCalledWith("test-key", { data: "new-value" }, 3600);
            
            // Verify L1 was populated by checking subsequent get returns from L1
            const result = await service.get("test-key");
            expect(mockProvider.get).not.toHaveBeenCalled(); // Should come from L1
            expect(result).toEqual({ data: "new-value" });
        });

        test("L2 write failure should still update L1", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn(),
                set: jest.fn().mockRejectedValue(new Error("L2 write failed")),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute
            const result = await service.set("test-key", { data: "new-value" }, 3600);

            // Verify L2 failed
            expect(result).toBe(false);
            
            // But L1 should still be populated (defensive strategy)
            const l1Result = localCache.get("test-key");
            expect(l1Result).toEqual({ data: "new-value" });
        });

        test("L2 read failure should not populate L1", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn().mockRejectedValue(new Error("L2 read failed")),
                set: jest.fn(),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute
            const result = await service.get("test-key");

            // Verify L2 failed
            expect(result).toBeNull();
            
            // L1 should NOT be populated
            const l1Result = localCache.get("test-key");
            expect(l1Result).toBeNull();
        });

        test("skipL1 option in set should only write to L2", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: jest.fn(),
                getProviderName: jest.fn(() => 'mock-provider'),
                get: jest.fn(),
                set: jest.fn().mockResolvedValue(true),
                delete: jest.fn(),
                disconnect: jest.fn(),
                getConnectionInfo: jest.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute with skipL1
            await service.set("test-key", { data: "new-value" }, 3600, { skipL1: true });

            // Verify L2 was called
            expect(mockProvider.set).toHaveBeenCalledWith("test-key", { data: "new-value" }, 3600);
            
            // Verify L1 was NOT populated
            const l1Result = localCache.get("test-key");
            expect(l1Result).toBeNull();
        });
    });
});