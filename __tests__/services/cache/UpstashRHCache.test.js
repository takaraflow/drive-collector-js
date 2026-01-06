import { jest, describe, test, expect, beforeEach, beforeAll } from "@jest/globals";

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock logger
await jest.unstable_mockModule("../../../src/services/logger.js", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

let UpstashRHCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/UpstashRHCache.js");
    UpstashRHCache = module.UpstashRHCache;
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe("UpstashRHCache", () => {
    test("should instantiate with correct options", () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123",
            name: "upstash-cache"
        });
        
        expect(cache.options.url).toBe("https://upstash.io");
        expect(cache.options.token).toBe("token123");
        expect(cache.options.name).toBe("upstash-cache");
    });

    test("should connect successfully", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });

        // Mock successful ping
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: "PONG" })
        });

        await cache.connect();
        
        expect(cache.connected).toBe(true);
    });

    test("should handle connection failure", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });

        // Mock API failure
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401
        });

        await expect(cache.connect()).rejects.toThrow("Failed to connect to Upstash");
        expect(cache.connected).toBe(false);
    });

    test("should get value as JSON", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        const mockValue = { data: "test" };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: JSON.stringify(mockValue) })
        });

        const result = await cache.get("test-key", "json");
        
        expect(result).toEqual(mockValue);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://upstash.io/get/test-key",
            expect.objectContaining({
                method: "POST",
                headers: { 
                    Authorization: `Bearer token123`,
                    "Content-Type": "application/json"
                }
            })
        );
    });

    test("should get value as string", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: "plain-text-value" })
        });

        const result = await cache.get("test-key", "string");
        
        expect(result).toBe("plain-text-value");
    });

    test("should return null for missing key", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: null })
        });

        const result = await cache.get("missing-key");
        
        expect(result).toBe(null);
    });

    test("should set value with TTL", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: "OK" })
        });

        const result = await cache.set("test-key", { data: "value" }, 3600);
        
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://upstash.io/set/test-key",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ 
                    value: '{"data":"value"}', 
                    ttl: 3600 
                }),
                headers: { 
                    Authorization: `Bearer token123`,
                    "Content-Type": "application/json"
                }
            })
        );
    });

    test("should delete value", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: 1 })
        });

        const result = await cache.delete("test-key");
        
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://upstash.io/del/test-key",
            expect.objectContaining({
                method: "POST",
                headers: { 
                    Authorization: `Bearer token123`,
                    "Content-Type": "application/json"
                }
            })
        );
    });

    test("should disconnect (no-op for HTTP)", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();
        
        await cache.disconnect();
        
        expect(cache.connected).toBe(false);
    });

    test("should get provider name", () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        
        expect(cache.getProviderName()).toBe("Upstash");
    });

    test("should get connection info", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123",
            name: "my-upstash"
        });
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({
            provider: "Upstash",
            name: "my-upstash",
            url: "https://upstash.io"
        });
    });

    test("should handle API errors gracefully", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        // Mock API error
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Internal Server Error"
        });

        const result = await cache.get("error-key");
        
        expect(result).toBe(null);
    });

    test("should handle JSON serialization errors on set", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        // Circular reference
        const circularObj = {};
        circularObj.self = circularObj;

        const result = await cache.set("circular-key", circularObj, 3600);
        
        expect(result).toBe(false);
    });

    test("should support pipeline operations", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });
        await cache.connect();

        // Mock pipeline response
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ result: ["OK", "OK"] })
        });

        // This tests if the underlying client supports pipeline
        // which is important for atomic operations
        const pipeline = cache.client.pipeline();
        expect(pipeline).toBeDefined();
        expect(typeof pipeline.set).toBe("function");
        expect(typeof pipeline.exec).toBe("function");
    });
});