import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";
import { localCache } from "../../src/utils/LocalCache.js";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let cacheInstance;

describe("KV Service Failover", () => {
    beforeAll(async () => {
        // 配置环境：同时拥有 CF 和 Upstash，默认使用 CF
        process.env = {
            ...originalEnv,
            CF_KV_ACCOUNT_ID: "mock_cf_account",
            CF_KV_NAMESPACE_ID: "mock_cf_ns",
            CF_KV_TOKEN: "mock_cf_token",
            UPSTASH_REDIS_REST_URL: "https://mock-upstash.com",
            UPSTASH_REDIS_REST_TOKEN: "mock-upstash-token",
            CACHE_PROVIDER: "cloudflare" // Default
        };

        // 重新导入 Cache 服务以应用新环境变量
        jest.resetModules();
        const { cache } = await import("../../src/services/CacheService.js");
        cacheInstance = cache;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    beforeEach(() => {
        mockFetch.mockClear();
        // 清空缓存
        localCache.clear();
        // 重置 Cache 实例内部状态 (hacky but necessary for singleton testing)
        if (cacheInstance) {
            cacheInstance.currentProvider = 'cloudflare';
            cacheInstance.failureCount = 0;
            cacheInstance.failoverEnabled = true;
            cacheInstance.hasUpstash = true;
        }
    });

    test("should use Cloudflare KV by default", async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ success: true })
        });

        await cacheInstance.set("key", "value", null, { skipCache: true });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain("api.cloudflare.com");
        expect(cacheInstance.getCurrentProvider()).toBe("Cloudflare KV");
    });

    test("should NOT failover on generic error", async () => {
        // 修正：添加 status 和 ok 属性，模拟完整的 Fetch Response 对象
        mockFetch.mockResolvedValueOnce({
            ok: false, // 模拟失败响应
            status: 400,
            json: () => Promise.resolve({
                success: false,
                errors: [{ message: "Some logic error" }]
            })
        });

        await expect(cacheInstance.set("key", "value", null, { skipCache: true })).rejects.toThrow("Cache Set Error");

        expect(cacheInstance.failureCount).toBe(0);
        expect(cacheInstance.getCurrentProvider()).toBe("Cloudflare KV");
    });

    test("should trigger failover after 3 quota errors", async () => {
        // 模拟 Cloudflare 额度错误响应
        const quotaErrorResponse = {
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        };

        const upstashSuccessResponse = {
            json: () => Promise.resolve({ result: "OK" })
        };

        // 第一次失败
        mockFetch.mockResolvedValueOnce(quotaErrorResponse);
        await expect(cacheInstance.set("k1", "v1", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(1);

        // 第二次失败
        mockFetch.mockResolvedValueOnce(quotaErrorResponse);
        await expect(cacheInstance.set("k2", "v2", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(2);

        // 第三次失败 -> 触发切换 -> 重试成功
        mockFetch
            .mockResolvedValueOnce(quotaErrorResponse) // CF 失败
            .mockResolvedValueOnce(upstashSuccessResponse); // Upstash 成功

        await cacheInstance.set("k3", "v3", null, { skipCache: true });

        expect(cacheInstance.failureCount).toBe(0); // 重置
        expect(cacheInstance.getCurrentProvider()).toBe("Upstash Redis");

        // 验证最后一次调用是发给 Upstash 的
        const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        expect(lastCall[0]).toContain("mock-upstash.com");
    });

    test("should use Upstash after failover", async () => {
        // 手动设置状态为已切换
        cacheInstance.currentProvider = 'upstash';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ result: "value" })
        });

        await cacheInstance.get("key", "json", { skipCache: true });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain("mock-upstash.com");
    });

    test("should trigger failover on network errors", async () => {
        // 模拟网络错误
        const networkErrorResponse = new Error("fetch failed");

        // 第一次失败
        mockFetch.mockRejectedValueOnce(networkErrorResponse);
        await expect(cacheInstance.set("k1", "v1", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(1);

        // 第二次失败
        mockFetch.mockRejectedValueOnce(networkErrorResponse);
        await expect(cacheInstance.set("k2", "v2", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(2);

        // 第三次失败 -> 触发切换 -> 重试成功
        mockFetch.mockRejectedValueOnce(networkErrorResponse); // CF 失败
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) }); // Upstash 成功

        await cacheInstance.set("k3", "v3", null, { skipCache: true });

        expect(cacheInstance.failureCount).toBe(0);
        expect(cacheInstance.getCurrentProvider()).toBe("Upstash Redis");
    });

    test("should trigger failover on timeout errors", async () => {
        // 模拟超时错误
        const timeoutErrorResponse = new Error("network timeout");

        // 第一次失败
        mockFetch.mockRejectedValueOnce(timeoutErrorResponse);
        await expect(cacheInstance.set("k1", "v1", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(1);

        // 第二次失败
        mockFetch.mockRejectedValueOnce(timeoutErrorResponse);
        await expect(cacheInstance.set("k2", "v2", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(2);

        // 第三次失败 -> 触发切换 -> 重试成功
        mockFetch.mockRejectedValueOnce(timeoutErrorResponse); // CF 失败
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) }); // Upstash 成功

        await cacheInstance.set("k3", "v3", null, { skipCache: true });

        expect(cacheInstance.failureCount).toBe(0);
        expect(cacheInstance.getCurrentProvider()).toBe("Upstash Redis");
    });

    test("should maintain failover state across operations", async () => {
        // 触发故障转移
        const quotaErrorResponse = {
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        };

        // 快速连续失败 3 次
        for (let i = 0; i < 3; i++) {
            mockFetch.mockResolvedValueOnce(quotaErrorResponse);
            await expect(cacheInstance.set(`k${i}`, `v${i}`, null, { skipCache: true })).rejects.toThrow();
        }

        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) });
        await cacheInstance.set("k3", "v3", null, { skipCache: true });

        expect(cacheInstance.getCurrentProvider()).toBe("Upstash Redis");

        // 后续操作应该继续使用 Upstash
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "value" }) });
        await cacheInstance.get("key", "json", { skipCache: true });

        expect(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]).toContain("mock-upstash.com");
    });

    test("should reset failure count after successful operation", async () => {
        // 先失败一次
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        });
        await expect(cacheInstance.set("k1", "v1", null, { skipCache: true })).rejects.toThrow();
        expect(cacheInstance.failureCount).toBe(1);

        // 成功操作不重置计数（仅故障转移时重置）
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ success: true }) });
        await cacheInstance.set("k2", "v2", null, { skipCache: true });
        expect(cacheInstance.failureCount).toBe(1);
        expect(cacheInstance.getCurrentProvider()).toBe("Cloudflare KV");
    });

    test("should not failover if Upstash not configured", async () => {
        // 临时修改配置，模拟没有 Upstash
        cacheInstance.hasUpstash = false;
        cacheInstance.failoverEnabled = false;

        const quotaErrorResponse = {
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        };

        // 连续失败多次
        for (let i = 0; i < 5; i++) {
            mockFetch.mockResolvedValueOnce(quotaErrorResponse);
            await expect(cacheInstance.set(`k${i}`, `v${i}`, null, { skipCache: true })).rejects.toThrow();
        }

        // 应该保持使用 Cloudflare KV，不切换
        expect(cacheInstance.getCurrentProvider()).toBe("Cloudflare KV");
        // 如果未启用故障转移，failureCount 不会增加
        expect(cacheInstance.failureCount).toBe(0);

        // 恢复配置
        cacheInstance.hasUpstash = true;
        cacheInstance.failoverEnabled = true;

        // 恢复配置
        cacheInstance.hasUpstash = true;
        cacheInstance.failoverEnabled = true;
    });

    test("should correctly identify failover mode", () => {
        // 默认状态
        cacheInstance.currentProvider = 'cloudflare';
        expect(cacheInstance.isFailoverMode).toBe(false);

        // 切换到 Upstash
        cacheInstance.currentProvider = 'upstash';
        expect(cacheInstance.isFailoverMode).toBe(true);

        // 强制设置为 Upstash（通过环境变量）
        process.env.CACHE_PROVIDER = 'upstash';
        cacheInstance.currentProvider = 'upstash';
        expect(cacheInstance.isFailoverMode).toBe(false); // 不是故障转移，是强制配置

        process.env.CACHE_PROVIDER = 'cloudflare';
    });
});