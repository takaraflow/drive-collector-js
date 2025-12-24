import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let kvInstance;

describe("KV Service", () => {
  beforeAll(async () => {
    // Set up mock environment variables
    process.env = {
      ...originalEnv,
      CF_ACCOUNT_ID: "mock_account_id",
      CF_KV_NAMESPACE_ID: "mock_namespace_id",
      CF_KV_TOKEN: "mock_kv_token",
    };
    jest.resetModules();

    // Dynamically import after setting up mocks
    const { kv: importedKV } = await import("../../src/services/kv.js");
    kvInstance = importedKV;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should initialize the KV service", () => {
    expect(kvInstance).toBeDefined();
    expect(kvInstance.accountId).toBe("mock_account_id");
    expect(kvInstance.namespaceId).toBe("mock_namespace_id");
    expect(kvInstance.token).toBe("mock_kv_token");
    expect(kvInstance.apiUrl).toBe("https://api.cloudflare.com/client/v4/accounts/mock_account_id/storage/kv/namespaces/mock_namespace_id");
  });

  describe("set", () => {
    test("should put a value successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true }),
      });

      const key = "test_key";
      const value = { foo: "bar" };
      await kvInstance.set(key, value);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`${kvInstance.apiUrl}/values/${key}`),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(value),
        })
      );
    });

    test("should handle expirationTtl", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true }),
      });

      const key = "test_key";
      const value = "test_value";
      const ttl = 3600;
      await kvInstance.set(key, value, ttl);

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain(`expiration_ttl=${ttl}`);
    });

    test("should throw error if set fails", async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ success: false, errors: [{ message: "KV write error" }] }),
        });

        await expect(kvInstance.set("key", "val")).rejects.toThrow("KV Set Error: KV write error");
    });
  });

  describe("get", () => {
    test("should get a JSON value successfully", async () => {
      const mockData = { a: 1 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      });

      const result = await kvInstance.get("key");
      expect(result).toEqual(mockData);
    });

    test("should get a text value successfully", async () => {
        const mockText = "plain text";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(mockText),
        });
  
        const result = await kvInstance.get("key", "text");
        expect(result).toBe(mockText);
    });

    test("should return null if key not found (404)", async () => {
        mockFetch.mockResolvedValueOnce({
          status: 404,
        });
  
        const result = await kvInstance.get("missing_key");
        expect(result).toBeNull();
    });

    test("should throw error if get fails", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ success: false, errors: [{ message: "KV read error" }] }),
        });

        await expect(kvInstance.get("key")).rejects.toThrow("KV Get Error: KV read error");
    });
  });

  describe("delete", () => {
    test("should delete a key successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

      const result = await kvInstance.delete("key");
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/values/key"),
        expect.objectContaining({ method: "DELETE" })
      );
    });

    test("should handle delete 404 gracefully", async () => {
        mockFetch.mockResolvedValueOnce({
          status: 404,
          json: () => Promise.resolve({ success: false }),
        });
  
        const result = await kvInstance.delete("missing_key");
        expect(result).toBe(true);
    });
  });

  describe("bulkSet", () => {
    test("should bulk set values successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true }),
      });

      const pairs = [
        { key: "k1", value: "v1" },
        { key: "k2", value: { obj: 1 } },
      ];
      await kvInstance.bulkSet(pairs);

      expect(mockFetch).toHaveBeenCalledWith(
        `${kvInstance.apiUrl}/bulk`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify([
            { key: "k1", value: "v1" },
            { key: "k2", value: JSON.stringify({ obj: 1 }) },
          ]),
        })
      );
    });
  });
});