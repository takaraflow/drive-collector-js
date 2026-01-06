import { jest, describe, test, expect, beforeEach, beforeAll } from "@jest/globals";

// Mock ioredis
const mockRedisConnect = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisQuit = jest.fn();
const mockRedisPing = jest.fn();
const mockRedisMulti = jest.fn(() => ({
    set: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(["OK", 1])
}));

const mockRedis = jest.fn().mockImplementation(() => ({
    connect: mockRedisConnect,
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    quit: mockRedisQuit,
    ping: mockRedisPing,
    multi: mockRedisMulti,
    status: "ready"
}));

await jest.unstable_mockModule("ioredis", () => ({
    __esModule: true,
    default: mockRedis
}));

// Mock logger
await jest.unstable_mockModule("../../../src/services/logger.js", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

let RedisCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/RedisCache.js");
    RedisCache = module.RedisCache;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisConnect.mockResolvedValue();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
    mockRedisDel.mockResolvedValue(1);
    mockRedisQuit.mockResolvedValue();
    mockRedisPing.mockResolvedValue("PONG");
});

describe("RedisCache", () => {
    test("should instantiate with correct URL", () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        expect(mockRedis).toHaveBeenCalledWith({ url: "redis://localhost:6379" });
    });

    test("should instantiate with name", () => {
        const cache = new RedisCache({ url: "redis://localhost:6379", name: "my-redis" });
        expect(cache.options.name).toBe("my-redis");
    });

    test("should connect successfully", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        expect(mockRedisConnect).toHaveBeenCalled();
        expect(cache.connected).toBe(true);
    });

    test("should get value as JSON by default", async () => {
        mockRedisGet.mockResolvedValue('{"data": "test"}');
        
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.get("key", "json");
        
        expect(mockRedisGet).toHaveBeenCalledWith("key");
        expect(result).toEqual({ data: "test" });
    });

    test("should get value as string", async () => {
        mockRedisGet.mockResolvedValue("test-value");
        
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.get("key", "string");
        
        expect(mockRedisGet).toHaveBeenCalledWith("key");
        expect(result).toBe("test-value");
    });

    test("should return null for missing key", async () => {
        mockRedisGet.mockResolvedValue(null);
        
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.get("missing-key");
        
        expect(result).toBe(null);
    });

    test("should set value with TTL", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.set("key", { data: "test" }, 3600);
        
        expect(mockRedisSet).toHaveBeenCalledWith("key", '{"data":"test"}', "EX", 3600);
        expect(result).toBe(true);
    });

    test("should set string value", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.set("key", "test-value", 3600);
        
        expect(mockRedisSet).toHaveBeenCalledWith("key", "test-value", "EX", 3600);
        expect(result).toBe(true);
    });

    test("should delete key", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.delete("key");
        
        expect(mockRedisDel).toHaveBeenCalledWith("key");
        expect(result).toBe(true);
    });

    test("should disconnect", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        await cache.disconnect();
        
        expect(mockRedisQuit).toHaveBeenCalled();
        expect(cache.connected).toBe(false);
    });

    test("should get provider name", () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        expect(cache.getProviderName()).toBe("Redis");
    });

    test("should get connection info", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379", name: "test-redis" });
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({
            provider: "Redis",
            name: "test-redis",
            url: "redis://localhost:6379",
            status: "ready"
        });
    });

    test("should handle JSON serialization errors", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        // Mock a circular reference that can't be stringified
        const circularObj = {};
        circularObj.self = circularObj;
        
        const result = await cache.set("key", circularObj, 3600);
        
        expect(result).toBe(false);
    });

    test("should handle JSON parsing errors", async () => {
        mockRedisGet.mockResolvedValue("invalid-json");
        
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        const result = await cache.get("key", "json");
        
        expect(result).toBe(null);
    });

    test("should support atomic operations (pipeline)", async () => {
        const cache = new RedisCache({ url: "redis://localhost:6379" });
        await cache.connect();
        
        // This tests if the underlying client supports multi/pipeline
        // which is important for atomic operations
        const multi = cache.client.multi();
        expect(multi).toBeDefined();
        expect(typeof multi.set).toBe("function");
        expect(typeof multi.del).toBe("function");
        expect(typeof multi.exec).toBe("function");
    });
});