// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock logger
vi.mock("../../../src/services/logger/index.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnThis(),
        configure: vi.fn(),
        isInitialized: vi.fn().mockReturnValue(true),
        canSend: vi.fn().mockReturnValue(true),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    },
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnThis(),
        configure: vi.fn(),
        isInitialized: vi.fn().mockReturnValue(true),
        canSend: vi.fn().mockReturnValue(true),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    },
    setInstanceIdProvider: vi.fn(),
    enableTelegramConsoleProxy: vi.fn(),
    disableTelegramConsoleProxy: vi.fn(),
    delay: vi.fn().mockResolvedValue(undefined),
    retryWithDelay: vi.fn().mockImplementation(async (fn) => await fn())
}));

let CloudflareKVCache;

beforeAll(async () => {
    const module = await import("../../../src/services/cache/CloudflareKVCache.js");
    CloudflareKVCache = module.CloudflareKVCache;
});

beforeEach(() => {
    mockFetch.mockReset();
    vi.clearAllMocks();
});

describe("CloudflareKVCache", () => {
    test("should instantiate with correct configuration", () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789",
            name: "cf-cache"
        });
        
        expect(cache.accountId).toBe("acc123");
        expect(cache.namespaceId).toBe("ns456");
        expect(cache.token).toBe("tok789");
        expect(cache.apiUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456");
    });

    test("should connect successfully", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });

        await cache.connect();
        
        expect(cache.connected).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("should not require network access on connect", async () => {
        const cache = new CloudflareKVCache({
            accountId: "acc123",
            namespaceId: "ns456",
            token: "tok789"
        });

        await cache.connect();
        expect(cache.connected).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
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
            json: async () => mockValue
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

        const result = await cache.get("test-key", "text");
        
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
            "https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/test-key?expiration_ttl=3600",
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
        
        expect(cache.getProviderName()).toBe("cloudflare");
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
            provider: "cloudflare",
            connected: true
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
