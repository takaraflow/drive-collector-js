import { jest, describe, test, expect, beforeEach, beforeAll } from "@jest/globals";

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

let UpstashRHCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/UpstashRHCache.js");
    UpstashRHCache = module.UpstashRHCache;
});

beforeEach(() => {
    mockFetch.mockReset();
    jest.clearAllMocks();
});

describe("UpstashRHCache", () => {
    test("should instantiate with correct configuration", () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123",
            name: "upstash-cache"
        });
        
        expect(cache.url).toBe("https://upstash.io");
        expect(cache.token).toBe("token123");
        expect(cache.apiUrl).toBe("https://upstash.io");
    });

    test("should connect successfully", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });

        await cache.connect();
        
        expect(cache.connected).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("should not require network access on connect", async () => {
        const cache = new UpstashRHCache({
            url: "https://upstash.io",
            token: "token123"
        });

        await cache.connect();
        expect(cache.connected).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
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
            json: async () => ({ result: JSON.stringify(mockValue) }),
            headers: { get: jest.fn().mockReturnValue(null) }
        });

        const result = await cache.get("test-key", "json");
        
        expect(result).toEqual(mockValue);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://upstash.io/exec",
            expect.objectContaining({
                method: "POST",
                headers: { 
                    Authorization: `Bearer token123`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["GET", "test-key"])
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
            json: async () => ({ result: "plain-text-value" }),
            headers: { get: jest.fn().mockReturnValue(null) }
        });

        const result = await cache.get("test-key", "text");
        
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
            json: async () => ({ result: null }),
            headers: { get: jest.fn().mockReturnValue(null) }
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
            json: async () => ({ result: "OK" }),
            headers: { get: jest.fn().mockReturnValue(null) }
        });

        const result = await cache.set("test-key", { data: "value" }, 3600);
        
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://upstash.io/exec",
            expect.objectContaining({
                method: "POST",
                headers: { 
                    Authorization: `Bearer token123`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["SET", "test-key", '{"data":"value"}', "EX", 3600])
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
            json: async () => ({ result: 1 }),
            headers: { get: jest.fn().mockReturnValue(null) }
        });

        const result = await cache.delete("test-key");
        
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://upstash.io/exec",
            expect.objectContaining({
                method: "POST",
                headers: { 
                    Authorization: `Bearer token123`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["DEL", "test-key"])
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
        
        expect(cache.getProviderName()).toBe("UpstashRHCache");
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
            provider: "UpstashRHCache",
            url: "https://upstash.io",
            hasToken: true,
            endpoint: "Upstash REST API"
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
            statusText: "Internal Server Error",
            headers: { get: jest.fn().mockReturnValue(null) }
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

        const pipeline = cache.pipeline();
        expect(pipeline).toBeDefined();
        expect(typeof pipeline.set).toBe("function");
        expect(typeof pipeline.exec).toBe("function");
    });
});
