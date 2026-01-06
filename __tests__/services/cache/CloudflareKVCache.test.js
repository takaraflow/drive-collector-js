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

let CloudflareKVCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/CloudflareKVCache.js");
    CloudflareKVCache = module.CloudflareKVCache;
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe("CloudflareKVCache", () => {
    test("should instantiate with correct options", () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789",
            name: "cf-cache"
        });
        
        expect(cache.options.accountId).toBe("acc123");
        expect(cache.options.namespaceId).toBe("ns456");
        expect(cache.options.token).toBe("tok789");
        expect(cache.options.name).toBe("cf-cache");
    });

    test("should connect successfully", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });

        // Mock successful API response for connection check
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true })
        });

        await cache.connect();
        
        expect(cache.connected).toBe(true);
    });

    test("should handle connection failure", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });

        // Mock API failure
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: "Unauthorized"
        });

        await expect(cache.connect()).rejects.toThrow("Failed to connect to Cloudflare KV");
        expect(cache.connected).toBe(false);
    });

    test("should get value as JSON", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
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
            "https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/test-key",
            expect.objectContaining({
                headers: { Authorization: "Bearer tok789" }
            })
        );
    });

    test("should get value as string", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => "plain-text-value"
        });

        const result = await cache.get("test-key", "string");
        
        expect(result).toBe("plain-text-value");
    });

    test("should return null for missing key", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404
        });

        const result = await cache.get("missing-key");
        
        expect(result).toBe(null);
    });

    test("should set value with TTL", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true })
        });

        const result = await cache.set("test-key", { data: "value" }, 3600);
        
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/test-key?ttl=3600",
            expect.objectContaining({
                method: "PUT",
                body: '{"data":"value"}',
                headers: { 
                    Authorization: "Bearer tok789",
                    "Content-Type": "application/json"
                }
            })
        );
    });

    test("should delete value", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        await cache.connect();

        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true })
        });

        const result = await cache.delete("test-key");
        
        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
            "https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/test-key",
            expect.objectContaining({
                method: "DELETE"
            })
        );
    });

    test("should disconnect (no-op for KV)", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        await cache.connect();
        
        await cache.disconnect();
        
        expect(cache.connected).toBe(false);
    });

    test("should get provider name", () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        
        expect(cache.getProviderName()).toBe("CloudflareKV");
    });

    test("should get connection info", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789",
            name: "my-cf"
        });
        await cache.connect();
        
        const info = cache.getConnectionInfo();
        
        expect(info).toEqual({
            provider: "CloudflareKV",
            name: "my-cf",
            accountId: "acc123",
            namespaceId: "ns456"
        });
    });

    test("should handle API errors gracefully", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
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
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });
        await cache.connect();

        // Circular reference
        const circularObj = {};
        circularObj.self = circularObj;

        const result = await cache.set("circular-key", circularObj, 3600);
        
        expect(result).toBe(false);
    });
});