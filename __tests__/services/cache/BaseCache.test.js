import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { BaseCache } from "../../../src/services/cache/BaseCache.js";

// Mock logger
await jest.unstable_mockModule("../../../src/services/logger.js", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

describe("BaseCache", () => {
    class TestCache extends BaseCache {
        constructor(options) {
            super(options);
            this.providerName = "TestCache";
        }

        async _connect() {
            this.connected = true;
        }

        async _get(key, type) {
            return `value-${key}`;
        }

        async _set(key, value, ttl) {
            return true;
        }

        async _delete(key) {
            return true;
        }

        async _disconnect() {
            this.connected = false;
        }

        getConnectionInfo() {
            return { provider: "TestCache", connected: this.connected };
        }
    }

    test("should initialize with default options", () => {
        const cache = new TestCache();
        expect(cache.options).toEqual({});
        expect(cache.providerName).toBe("TestCache");
    });

    test("should initialize with custom name", () => {
        const cache = new TestCache({ name: "my-cache" });
        expect(cache.options.name).toBe("my-cache");
    });

    test("connect() should call _connect and set connected flag", async () => {
        const cache = new TestCache();
        await cache.connect();
        
        expect(cache.connected).toBe(true);
    });

    test("connect() should be idempotent", async () => {
        const cache = new TestCache();
        const connectSpy = jest.spyOn(cache, '_connect');
        
        await cache.connect();
        await cache.connect();
        
        expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    test("get() should throw if not connected", async () => {
        const cache = new TestCache();
        
        await expect(cache.get("key")).rejects.toThrow("Not connected");
    });

    test("get() should call _get if connected", async () => {
        const cache = new TestCache();
        await cache.connect();
        
        const result = await cache.get("test-key", "json");
        
        expect(result).toBe("value-test-key");
    });

    test("set() should throw if not connected", async () => {
        const cache = new TestCache();
        
        await expect(cache.set("key", "value")).rejects.toThrow("Not connected");
    });

    test("set() should call _set if connected", async () => {
        const cache = new TestCache();
        await cache.connect();
        
        const result = await cache.set("test-key", "test-value", 3600);
        
        expect(result).toBe(true);
    });

    test("delete() should throw if not connected", async () => {
        const cache = new TestCache();
        
        await expect(cache.delete("key")).rejects.toThrow("Not connected");
    });

    test("delete() should call _delete if connected", async () => {
        const cache = new TestCache();
        await cache.connect();
        
        const result = await cache.delete("test-key");
        
        expect(result).toBe(true);
    });

    test("disconnect() should call _disconnect and clear connected flag", async () => {
        const cache = new TestCache();
        await cache.connect();
        
        await cache.disconnect();
        
        expect(cache.connected).toBe(false);
    });

    test("getProviderName() should return provider name", () => {
        const cache = new TestCache();
        
        expect(cache.getProviderName()).toBe("TestCache");
    });

    test("getConnectionInfo() should return connection info", async () => {
        const cache = new TestCache();
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({ provider: "TestCache", connected: true });
    });
});