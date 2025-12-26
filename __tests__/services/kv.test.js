import { jest, describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "@jest/globals";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;

describe("KV Service Full Suite", () => {
  let kvInstance;

  async function reloadKVService(env) {
    process.env = { ...originalEnv, ...env };
    jest.resetModules();
    const module = await import("../../src/services/kv.js");
    return module.kv;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ✨ 关键修复：解决测试卡死 (Hang)
  afterEach(() => {
    if (kvInstance && kvInstance.recoveryTimer) {
      clearInterval(kvInstance.recoveryTimer);
      kvInstance.recoveryTimer = null;
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ==========================================
  // 1. Cloudflare Provider 测试
  // ==========================================
  describe("Cloudflare Provider", () => {
    beforeAll(async () => {
      kvInstance = await reloadKVService({
        CF_ACCOUNT_ID: "cf_acc",
        CF_KV_NAMESPACE_ID: "cf_ns",
        CF_KV_TOKEN: "cf_token",
        KV_PROVIDER: "cloudflare"
      });
    });

    test("should initialize Cloudflare correctly", () => {
      expect(kvInstance.accountId).toBe("cf_acc");
      expect(kvInstance.apiUrl).toContain("cf_acc/storage/kv/namespaces/cf_ns");
    });

    test("should put a value via PUT method", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
      await kvInstance.set("k1", { foo: "bar" });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/values/k1"), expect.objectContaining({ method: "PUT" }));
    });

    test("should handle expirationTtl in URL", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
      await kvInstance.set("k1", "v1", 3600);
      expect(mockFetch.mock.calls[0][0]).toContain("expiration_ttl=3600");
    });

    test("should get JSON value successfully", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ a: 1 }) });
      expect(await kvInstance.get("key")).toEqual({ a: 1 });
    });

    test("should return null on 404", async () => {
      mockFetch.mockResolvedValueOnce({ status: 404 });
      expect(await kvInstance.get("missing")).toBeNull();
    });

    test("should delete a key successfully", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      expect(await kvInstance.delete("key")).toBe(true);
    });
  });

  // ==========================================
  // 2. Upstash Provider 测试 (适配 Pipeline)
  // ==========================================
  describe("Upstash Provider", () => {
    beforeAll(async () => {
      kvInstance = await reloadKVService({
        KV_PROVIDER: "upstash",
        UPSTASH_REDIS_REST_URL: "https://mock.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "up_token"
      });
    });

    test("should set value using POST body", async () => {
      mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) });
      await kvInstance.set("k1", { x: 1 });
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST", body: JSON.stringify({ x: 1 }) }));
    });

    test("should bulkSet using Pipeline API", async () => {
      mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve([{ result: "OK" }]) });
      await kvInstance.bulkSet([{ key: "k1", value: "v1" }]);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/pipeline"), expect.any(Object));
    });
  });

  // ==========================================
  // 3. 故障转移深度测试 (修正连锁反应)
  // ==========================================
  describe("Failover Logic Deep Dive", () => {
    beforeAll(async () => {
      kvInstance = await reloadKVService({
        CF_ACCOUNT_ID: "cf", CF_KV_NAMESPACE_ID: "ns", CF_KV_TOKEN: "tk",
        UPSTASH_REDIS_REST_URL: "https://up.io", UPSTASH_REDIS_REST_TOKEN: "ut"
      });
    });

    test("should NOT failover on generic errors (e.g., 400 Bad Request)", async () => {
      // 模拟逻辑错误：不应触发重试
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 400,
        json: () => Promise.resolve({ success: false, errors: [{ message: "invalid key" }] })
      });

      await expect(kvInstance.set("invalid", "v")).rejects.toThrow("KV Set Error");
      expect(kvInstance.failureCount).toBe(0); // 验证没有累加错误计数
    });

    test("should switch to Upstash after 3 rate limit errors", async () => {
      const rateLimitErr = { success: false, errors: [{ message: "rate limit" }] };
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 429, json: () => Promise.resolve(rateLimitErr) })
        .mockResolvedValueOnce({ ok: false, status: 429, json: () => Promise.resolve(rateLimitErr) })
        .mockResolvedValueOnce({ ok: false, status: 429, json: () => Promise.resolve(rateLimitErr) })
        .mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) });

      await kvInstance.set("key", "val");
      expect(kvInstance.currentProvider).toBe("upstash");
    });
  });
});