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
    options: options // Expose options for verification
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

let ValkeyTLSCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/ValkeyTLSCache.js");
    ValkeyTLSCache = module.ValkeyTLSCache;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisConnect.mockResolvedValue();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
    mockRedisDel.mockResolvedValue(1);
    mockRedisQuit.mockResolvedValue();
});

describe("ValkeyTLSCache", () => {
    test("should instantiate with TLS options", () => {
        const options = {
            url: "valkeys://valkey-host:6380",
            rejectUnauthorized: true,
            servername: "valkey-host"
        };
        
        const cache = new ValkeyTLSCache(options);
        
        expect(mockRedis).toHaveBeenCalledWith({
            url: "valkeys://valkey-host:6380",
            tls: {
                rejectUnauthorized: true,
                servername: "valkey-host"
            }
        });
    });

    test("should handle default TLS rejectUnauthorized as true", () => {
        const options = {
            url: "valkeys://valkey-host:6380",
            servername: "valkey-host"
        };
        
        const cache = new ValkeyTLSCache(options);
        
        expect(mockRedis).toHaveBeenCalledWith({
            url: "valkeys://valkey-host:6380",
            tls: {
                rejectUnauthorized: true,
                servername: "valkey-host"
            }
        });
    });

    test("should allow disabling rejectUnauthorized", () => {
        const options = {
            url: "valkeys://valkey-host:6380",
            rejectUnauthorized: false,
            servername: "valkey-host"
        };
        
        const cache = new ValkeyTLSCache(options);
        
        expect(mockRedis).toHaveBeenCalledWith({
            url: "valkeys://valkey-host:6380",
            tls: {
                rejectUnauthorized: false,
                servername: "valkey-host"
            }
        });
    });

    test("should connect successfully with TLS", async () => {
        const cache = new ValkeyTLSCache({
            url: "valkeys://valkey-host:6380",
            rejectUnauthorized: true
        });
        
        await cache.connect();
        
        expect(mockRedisConnect).toHaveBeenCalled();
        expect(cache.connected).toBe(true);
    });

    test("should get provider name", () => {
        const cache = new ValkeyTLSCache({
            url: "valkeys://valkey-host:6380",
            rejectUnauthorized: true
        });
        
        expect(cache.getProviderName()).toBe("ValkeyTLS");
    });

    test("should get connection info with TLS details", async () => {
        const cache = new ValkeyTLSCache({
            url: "valkeys://valkey-host:6380",
            rejectUnauthorized: true,
            servername: "valkey-host",
            name: "secure-valkey"
        });
        
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({
            provider: "ValkeyTLS",
            name: "secure-valkey",
            url: "valkeys://valkey-host:6380",
            tls: true,
            status: "ready"
        });
    });

    test("should handle standard operations over TLS", async () => {
        mockRedisGet.mockResolvedValue('{"secure": "data"}');
        
        const cache = new ValkeyTLSCache({
            url: "valkeys://valkey-host:6380",
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
        const cache = new ValkeyTLSCache({
            url: "valkeys://valkey-host:6380",
            rejectUnauthorized: true
        });
        
        await cache.connect();
        await cache.disconnect();
        
        expect(mockRedisQuit).toHaveBeenCalled();
        expect(cache.connected).toBe(false);
    });
});