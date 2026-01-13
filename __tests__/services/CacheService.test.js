// Mock dependencies to prevent real I/O
vi.mock("../../src/utils/LocalCache.js", () => ({
    localCache: {
        isUnchanged: vi.fn(() => false),
        set: vi.fn(),
        get: vi.fn(() => undefined),
        del: vi.fn(),
        delete: vi.fn()
    }
}));

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
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

// Mock all provider classes to prevent real connections
vi.mock("../../src/services/cache/RedisCache.js", () => ({
    RedisCache: vi.fn().mockImplementation(function(config) {
        return {
            config,
            connect: vi.fn().mockResolvedValue(undefined),
            initialize: vi.fn(),
            getProviderName: vi.fn().mockReturnValue('redis'),
            get: vi.fn(),
            set: vi.fn().mockResolvedValue(true),
            delete: vi.fn().mockResolvedValue(true),
            disconnect: vi.fn()
        };
    })
}));

vi.mock("../../src/services/cache/UpstashRHCache.js", () => ({
    UpstashRHCache: vi.fn().mockImplementation(function() {
        return {
            connect: vi.fn().mockResolvedValue(undefined),
            initialize: vi.fn(),
            getProviderName: vi.fn().mockReturnValue('upstash'),
            get: vi.fn(),
            set: vi.fn().mockResolvedValue(true),
            delete: vi.fn().mockResolvedValue(true),
            disconnect: vi.fn()
        };
    }),
    UpstashRHCache: {
        detectConfig: vi.fn(() => null)
    }
}));

vi.mock("../../src/services/cache/NorthFlankRTCache.js", () => ({
    NorthFlankRTCache: vi.fn().mockImplementation(function() {
        return {
            connect: vi.fn().mockResolvedValue(undefined),
            initialize: vi.fn(),
            getProviderName: vi.fn().mockReturnValue('northflank'),
            get: vi.fn(),
            set: vi.fn().mockResolvedValue(true),
            delete: vi.fn().mockResolvedValue(true),
            disconnect: vi.fn()
        };
    }),
    NorthFlankRTCache: {
        detectConfig: vi.fn(() => null)
    }
}));

vi.mock("../../src/services/cache/MemoryCache.js", () => ({
    MemoryCache: vi.fn().mockImplementation(function() {
        return {
            connect: vi.fn().mockResolvedValue(undefined),
            initialize: vi.fn(),
            getProviderName: vi.fn(() => 'MemoryCache'),
            get: vi.fn(() => null),
            set: vi.fn(() => true),
            delete: vi.fn(() => true),
            listKeys: vi.fn(() => []),
            disconnect: vi.fn()
        };
    })
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import { CacheService } from "../../src/services/CacheService.js";

describe("CacheService Integration Tests", () => {
    let service;
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.clearAllMocks();
        mockFetch.mockClear();
        vi.useFakeTimers();
        vi.resetModules();
    });

    afterEach(async () => {
        if (service) {
            await service.destroy().catch(() => {});
        }
        service = null;
        vi.useRealTimers();
        vi.clearAllTimers();
    });

    describe("Redis Provider", () => {
        beforeEach(async () => {
            service = new CacheService({
                env: {
                    REDIS_URL: "redis://localhost:6379"
                }
            });
            await service.initialize();
            service.stopRecoveryCheck();
        });

        test("should initialize Redis correctly", () => {
            expect(service.currentProviderName).toBe('redis');
        });

        test("should put a value", async () => {
            const result = await service.set("k1", { foo: "bar" });
            expect(result).toBe(true);
        });

        test("should get JSON value successfully", async () => {
            service.primaryProvider.get.mockResolvedValueOnce({ foo: "bar" });
            const result = await service.get("key", "json", { skipL1: true });
            expect(result).toEqual({ foo: "bar" });
        });

        test("should return null for missing key", async () => {
            service.primaryProvider.get.mockResolvedValueOnce(null);
            expect(await service.get("missing", "json", { skipL1: true })).toBeNull();
        });

        test("should delete a key successfully", async () => {
            expect(await service.delete("key")).toBe(true);
        });
    });

    describe("Memory Fallback Provider", () => {
        test("should fallback to memory when no credentials provided", async () => {
            service = new CacheService({ env: {} });
            await service.initialize();
            expect(service.currentProviderName).toBe('MemoryCache');
        });

        test("should return null for get in memory mode", async () => {
            service = new CacheService({ env: {} });
            await service.initialize();
            const result = await service.get("test-key", "json", { skipL1: true });
            expect(result).toBeNull();
        });

        test("should return true for set in memory mode", async () => {
            service = new CacheService({ env: {} });
            await service.initialize();
            const result = await service.set("test-key", "test-value");
            expect(result).toBe(true);
        });
    });

    describe("Lifecycle", () => {
        test("should stop recovery check when destroy is called", async () => {
            service = new CacheService({
                env: {
                    REDIS_URL: "redis://localhost:6379"
                }
            });
            await service.initialize();
            // Trigger failure to start recovery timer
            await service._handleProviderFailure(new Error("Fail"));
            await service._handleProviderFailure(new Error("Fail"));
            await service._handleProviderFailure(new Error("Fail"));
            
            expect(service.recoveryTimer).toBeDefined();
            await service.destroy();
            expect(service.recoveryTimer).toBeNull();
        });
    });

    describe("Error Handling", () => {
        test("should handle provider get errors gracefully", async () => {
            service = new CacheService({
                env: {
                    REDIS_URL: "redis://localhost:6379"
                }
            });
            await service.initialize();
            service.primaryProvider.get.mockRejectedValue(new Error("Connection error"));

            const result = await service.get("test-key", "json", { skipL1: true });
            expect(result).toBeNull();
            expect(service.failureCount).toBe(1);
        });

        test("should handle set operation failures", async () => {
            service = new CacheService({
                env: {
                    REDIS_URL: "redis://localhost:6379"
                }
            });
            await service.initialize();
            service.primaryProvider.set.mockResolvedValue(false);
            
            const result = await service.set("test-key", "test-value");
            expect(result).toBe(false);
        });
    });
});
