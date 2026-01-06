import { jest, describe, test, expect, beforeEach, beforeAll } from "@jest/globals";

// Mock ioredis
const mockRedisConnect = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisQuit = jest.fn();

const mockRedis = jest.fn().mockImplementation((options) => ({
    connect: mockRedisConnect,
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    quit: mockRedisQuit,
    status: "ready",
    options: options
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

let RedisTLSCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/RedisTLSCache.js");
    RedisTLSCache = module.RedisTLSCache;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisConnect.mockResolvedValue();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
    mockRedisDel.mockResolvedValue(1);
    mockRedisQuit.mockResolvedValue();
});

describe("RedisTLSCache", () => {
    test("should instantiate with TLS options", () => {
        const options = {
            url: "rediss://redis-host:6380",
            rejectUnauthorized: true,
            servername: "redis-host"
        };
        
        const cache = new RedisTLSCache(options);
        
        expect(mockRedis).toHaveBeenCalledWith({
            url: "rediss://redis-host:6380",
            tls: {
                rejectUnauthorized: true,
                servername: "redis-host"
            }
        });
    });

    test("should handle default TLS rejectUnauthorized as true", () => {
        const options = {
            url: "rediss://redis-host:6380",
            servername: "redis-host"
        };
        
        const cache = new RedisTLSCache(options);
        
        expect(mockRedis).toHaveBeenCalledWith({
            url: "rediss://redis-host:6380",
            tls: {
                rejectUnauthorized: true,
                servername: "redis-host"
            }
        });
    });

    test("should allow disabling rejectUnauthorized", () => {
        const options = {
            url: "rediss://redis-host:6380",
            rejectUnauthorized: false,
            servername: "redis-host"
        };
        
        const cache = new RedisTLSCache(options);
        
        expect(mockRedis).toHaveBeenCalledWith({
            url: "rediss://redis-host:6380",
            tls: {
                rejectUnauthorized: false,
                servername: "redis-host"
            }
        });
    });

    test("should connect successfully with TLS", async () => {
        const cache = new RedisTLSCache({
            url: "rediss://redis-host:6380",
            rejectUnauthorized: true
        });
        
        await cache.connect();
        
        expect(mockRedisConnect).toHaveBeenCalled();
        expect(cache.connected).toBe(true);
    });

    test("should get provider name", () => {
        const cache = new RedisTLSCache({
            url: "rediss://redis-host:6380",
            rejectUnauthorized: true
        });
        
        expect(cache.getProviderName()).toBe("RedisTLS");
    });

    test("should get connection info with TLS details", async () => {
        const cache = new RedisTLSCache({
            url: "rediss://redis-host:6380",
            rejectUnauthorized: true,
            servername: "redis-host",
            name: "secure-redis"
        });
        
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({
            provider: "RedisTLS",
            name: "secure-redis",
            url: "rediss://redis-host:6380",
            tls: true,
            status: "ready"
        });
    });

    test("should handle standard operations over TLS", async () => {
        mockRedisGet.mockResolvedValue('{"secure": "data"}');
        
        const cache = new RedisTLSCache({
            url: "rediss://redis-host:6380",
            rejectUnauthorized: true
        });
        
        await cache.connect();
        
        // Set
        const setResult = await cache.set("secure-key", { secure: "data" }, 3600);
        expect(setResult).toBe(true);
        expect(mockRedisSet).toHaveBeenCalledWith("secure-key", '{"secure":"data"}', "EX", 3600);
        
        // Get
        const getResult = await cache.get("secure-key", "json");
        expect(getResult).toEqual({ secure: "data" });
        expect(mockRedisGet).toHaveBeenCalledWith("secure-key");
        
        // Delete
        const delResult = await cache.delete("secure-key");
        expect(delResult).toBe(true);
        expect(mockRedisDel).toHaveBeenCalledWith("secure-key");
    });

    test("should disconnect properly", async () => {
        const cache = new RedisTLSCache({
            url: "rediss://redis-host:6380",
            rejectUnauthorized: true
        });
        
        await cache.connect();
        await cache.disconnect();
        
        expect(mockRedisQuit).toHaveBeenCalled();
        expect(cache.connected).toBe(false);
    });
});