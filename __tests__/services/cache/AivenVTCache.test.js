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

let AivenVTCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/AivenVTCache.js");
    AivenVTCache = module.AivenVTCache;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisConnect.mockResolvedValue();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
    mockRedisDel.mockResolvedValue(1);
    mockRedisQuit.mockResolvedValue();
});

describe("AivenVTCache", () => {
    test("should instantiate with Aiven-specific TLS configuration", () => {
        const options = {
            url: "redis://aiven-host:16379",
            name: "aiven-valkey"
        };
        
        const cache = new AivenVTCache(options);
        
        // AivenVTCache should enforce strict TLS
        expect(mockRedis).toHaveBeenCalledWith({
            url: "redis://aiven-host:16379",
            tls: {
                rejectUnauthorized: true,
                servername: "aiven-host"
            }
        });
    });

    test("should connect successfully", async () => {
        const cache = new AivenVTCache({
            url: "redis://aiven-host:16379",
            name: "aiven-valkey"
        });
        
        await cache.connect();
        
        expect(mockRedisConnect).toHaveBeenCalled();
        expect(cache.connected).toBe(true);
    });

    test("should get provider name", () => {
        const cache = new AivenVTCache({
            url: "redis://aiven-host:16379",
            name: "aiven-valkey"
        });
        
        expect(cache.getProviderName()).toBe("AivenValkey");
    });

    test("should get connection info with Aiven details", async () => {
        const cache = new AivenVTCache({
            url: "redis://aiven-host:16379",
            name: "aiven-valkey"
        });
        
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({
            provider: "AivenValkey",
            name: "aiven-valkey",
            url: "redis://aiven-host:16379",
            tls: true,
            status: "ready"
        });
    });

    test("should handle standard operations", async () => {
        mockRedisGet.mockResolvedValue('{"aiven": "data"}');
        
        const cache = new AivenVTCache({
            url: "redis://aiven-host:16379",
            name: "aiven-valkey"
        });
        
        await cache.connect();
        
        // Set
        const setResult = await cache.set("aiven-key", { aiven: "data" }, 3600);
        expect(setResult).toBe(true);
        expect(mockRedisSet).toHaveBeenCalledWith("aiven-key", '{"aiven":"data"}', "EX", 3600);
        
        // Get
        const getResult = await cache.get("aiven-key", "json");
        expect(getResult).toEqual({ aiven: "data" });
        expect(mockRedisGet).toHaveBeenCalledWith("aiven-key");
        
        // Delete
        const delResult = await cache.delete("aiven-key");
        expect(delResult).toBe(true);
        expect(mockRedisDel).toHaveBeenCalledWith("aiven-key");
    });

    test("should disconnect properly", async () => {
        const cache = new AivenVTCache({
            url: "redis://aiven-host:16379",
            name: "aiven-valkey"
        });
        
        await cache.connect();
        await cache.disconnect();
        
        expect(mockRedisQuit).toHaveBeenCalled();
        expect(cache.connected).toBe(false);
    });

    test("should enforce strict TLS regardless of input options", () => {
        // Even if someone tries to disable TLS, AivenVTCache should enforce it
        const options = {
            url: "redis://aiven-host:16379",
            name: "aiven-valkey",
            rejectUnauthorized: false // This should be ignored
        };
        
        const cache = new AivenVTCache(options);
        
        // Should still use strict TLS
        expect(mockRedis).toHaveBeenCalledWith({
            url: "redis://aiven-host:16379",
            tls: {
                rejectUnauthorized: true,
                servername: "aiven-host"
            }
        });
    });
});