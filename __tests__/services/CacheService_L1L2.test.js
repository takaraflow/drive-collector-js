// Mock dependencies to prevent real I/O
vi.mock("../../src/config/index.js", () => ({
    getConfig: vi.fn(() => ({ kv: {} })),
    initConfig: vi.fn(async () => ({ kv: {} })),
    config: { kv: {} }
}));

vi.mock("../../src/services/logger/index.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    }
}));

// Mock all provider classes to prevent real connections
vi.mock("../../src/services/cache/RedisCache.js", () => ({
    RedisCache: vi.fn().mockImplementation(() => ({
        initialize: vi.fn(),
        getProviderName: vi.fn(() => 'redis'),
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        disconnect: vi.fn()
    }))
}));

vi.mock("../../src/services/cache/UpstashRHCache.js", () => ({
    UpstashRHCache: vi.fn().mockImplementation(() => ({
        initialize: vi.fn(),
        getProviderName: vi.fn(() => 'upstash'),
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        disconnect: vi.fn()
    }))
}));

vi.mock("../../src/services/cache/MemoryCache.js", () => ({
    MemoryCache: vi.fn().mockImplementation(() => ({
        initialize: vi.fn(),
        getProviderName: vi.fn(() => 'MemoryCache'),
        get: vi.fn(() => null),
        set: vi.fn(() => true),
        delete: vi.fn(() => true),
        listKeys: vi.fn(() => []),
        disconnect: vi.fn()
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
        vi.clearAllMocks();
        vi.useFakeTimers();
        // Clear LocalCache before each test
        localCache.clear();
    });

    afterEach(async () => {
        if (service) {
            await service.destroy().catch(() => {});
        }
        service = null;
        vi.useRealTimers();
        vi.clearAllTimers();
        localCache.clear();
    });

    describe("L1/L2 Interaction", () => {
        test("injected empty env should isolate optional cache features from global env", async () => {
            process.env.CACHE_L3_ENABLED = 'true';
            process.env.CACHE_BLOOM_FILTER = 'true';

            service = new CacheService({ env: {} });
            await service.initialize();

            expect(service.currentProviderName).toBe('MemoryCache');
            expect(service.l3Enabled).toBe(false);
            expect(service.l3Cache).toBeNull();
            expect(service.bloomFilterEnabled).toBe(false);
            expect(service.bloomFilter).toBeNull();
        });

        test("L1 miss should trigger L2 read and populate L1", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockResolvedValue({ data: "cached-value" }),
                set: vi.fn(),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
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
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockResolvedValue({ data: "should-not-be-called" }),
                set: vi.fn(),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
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
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockResolvedValue({ data: "l2-value" }),
                set: vi.fn(),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
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

        test("skipCache option bypasses L1 and does not repopulate it", async () => {
            localCache.set("lock:telegram_client", { instanceId: "stale" }, 10000);

            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockResolvedValue({ instanceId: "fresh" }),
                set: vi.fn(),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            const result = await service.get("lock:telegram_client", "json", { skipCache: true });

            expect(result).toEqual({ instanceId: "fresh" });
            expect(mockProvider.get).toHaveBeenCalledWith("lock:telegram_client", "json");
            expect(localCache.get("lock:telegram_client")).toEqual({ instanceId: "stale" });
        });

        test("skipCache option bypasses bloom filter misses for authoritative lock reads", async () => {
            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockResolvedValue({ instanceId: "fresh" }),
                set: vi.fn(),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';
            service.bloomFilterEnabled = true;
            service.bloomFilter = {
                has: vi.fn(() => false),
                add: vi.fn()
            };

            const result = await service.get("lock:telegram_client", "json", { skipCache: true });

            expect(result).toEqual({ instanceId: "fresh" });
            expect(service.bloomFilter.has).not.toHaveBeenCalled();
            expect(mockProvider.get).toHaveBeenCalledWith("lock:telegram_client", "json");
        });

        test("compareAndSet invalidates L1 after native CAS succeeds", async () => {
            localCache.set("lock:telegram_client", { instanceId: "stale" }, 10000);

            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn(),
                set: vi.fn(),
                delete: vi.fn(),
                compareAndSet: vi.fn().mockResolvedValue(true),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            const result = await service.compareAndSet(
                "lock:telegram_client",
                { instanceId: "fresh" },
                { ifNotExists: true, ttl: 90 }
            );

            expect(result).toBe(true);
            expect(localCache.get("lock:telegram_client")).toBeNull();
        });

        test("deleteIfEquals delegates atomic provider delete and clears L1", async () => {
            localCache.set("lock:telegram_client", { instanceId: "stale" }, 10000);

            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn(),
                set: vi.fn(),
                delete: vi.fn(),
                deleteIfEquals: vi.fn().mockResolvedValue(true),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            const expected = { instanceId: "leader" };
            const deleted = await service.deleteIfEquals("lock:telegram_client", expected);

            expect(deleted).toBe(true);
            expect(mockProvider.deleteIfEquals).toHaveBeenCalledWith("lock:telegram_client", expected);
            expect(localCache.get("lock:telegram_client")).toBeNull();
        });

        test("deleteIfEquals returns false when atomic delete is required but provider lacks it", async () => {
            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockResolvedValue({ instanceId: "leader" }),
                set: vi.fn(),
                delete: vi.fn().mockResolvedValue(true),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            const deleted = await service.deleteIfEquals(
                "lock:telegram_client",
                { instanceId: "leader" },
                { requireAtomic: true }
            );

            expect(deleted).toBe(false);
            expect(mockProvider.get).not.toHaveBeenCalled();
            expect(mockProvider.delete).not.toHaveBeenCalled();
        });

        test("L2 write should also update L1 (write-through to L1)", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn(),
                set: vi.fn().mockResolvedValue(true),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute with skipTtlRandomization to ensure exact TTL
            await service.set("test-key", { data: "new-value" }, 3600, { skipTtlRandomization: true });

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
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn(),
                set: vi.fn().mockRejectedValue(new Error("L2 write failed")),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute with skipTtlRandomization to ensure exact TTL
            const result = await service.set("test-key", { data: "new-value" }, 3600, { skipTtlRandomization: true });

            // Verify L2 failed
            expect(result).toBe(false);
            
            // But L1 should still be populated (defensive strategy)
            const l1Result = localCache.get("test-key");
            expect(l1Result).toEqual({ data: "new-value" });
        });

        test("L2 read failure should not populate L1", async () => {
            // Create a mock provider
            const mockProvider = {
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn().mockRejectedValue(new Error("L2 read failed")),
                set: vi.fn(),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
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
                initialize: vi.fn(),
                getProviderName: vi.fn(() => 'mock-provider'),
                get: vi.fn(),
                set: vi.fn().mockResolvedValue(true),
                delete: vi.fn(),
                disconnect: vi.fn(),
                getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
            };

            // Create service and manually set provider
            service = new CacheService({ env: {} });
            await service.initialize();
            service.primaryProvider = mockProvider;
            service.currentProviderName = 'mock-provider';

            // Execute with skipL1 and skipTtlRandomization
            await service.set("test-key", { data: "new-value" }, 3600, { skipL1: true, skipTtlRandomization: true });

            // Verify L2 was called
            expect(mockProvider.set).toHaveBeenCalledWith("test-key", { data: "new-value" }, 3600);
            
            // Verify L1 was NOT populated
            const l1Result = localCache.get("test-key");
            expect(l1Result).toBeNull();
        });
    });
});
