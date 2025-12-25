import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let kvInstance;

describe("KV Service Failover", () => {
    beforeAll(async () => {
        // 配置环境：同时拥有 CF 和 Upstash，默认使用 CF
        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "mock_cf_account",
            CF_KV_NAMESPACE_ID: "mock_cf_ns",
            CF_KV_TOKEN: "mock_cf_token",
            UPSTASH_REDIS_REST_URL: "https://mock-upstash.com",
            UPSTASH_REDIS_REST_TOKEN: "mock-upstash-token",
            KV_PROVIDER: "cloudflare" // Default
        };

        // 重新导入 KV 服务以应用新环境变量
        jest.resetModules();
        const { kv } = await import("../../src/services/kv.js");
        kvInstance = kv;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    beforeEach(() => {
        mockFetch.mockClear();
        // 重置 KV 实例内部状态 (hacky but necessary for singleton testing)
        if (kvInstance) {
            kvInstance.currentProvider = 'cloudflare';
            kvInstance.failureCount = 0;
            kvInstance.failoverEnabled = true;
            kvInstance.hasUpstash = true;
        }
    });

    test("should use Cloudflare KV by default", async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ success: true })
        });

        await kvInstance.set("key", "value");

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain("api.cloudflare.com");
        expect(kvInstance.getCurrentProvider()).toBe("Cloudflare KV");
    });

    test("should NOT failover on generic error", async () => {
        // 模拟普通错误 (e.g. 404, logic error)
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ success: false, errors: [{ message: "Some logic error" }] })
        });

        await expect(kvInstance.set("key", "value")).rejects.toThrow("KV Set Error");

        expect(kvInstance.failureCount).toBe(0);
        expect(kvInstance.getCurrentProvider()).toBe("Cloudflare KV");
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
        await expect(kvInstance.set("k1", "v1")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(1);

        // 第二次失败
        mockFetch.mockResolvedValueOnce(quotaErrorResponse);
        await expect(kvInstance.set("k2", "v2")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(2);

        // 第三次失败 -> 触发切换 -> 重试成功
        mockFetch
            .mockResolvedValueOnce(quotaErrorResponse) // CF 失败
            .mockResolvedValueOnce(upstashSuccessResponse); // Upstash 成功

        await kvInstance.set("k3", "v3");

        expect(kvInstance.failureCount).toBe(0); // 重置
        expect(kvInstance.getCurrentProvider()).toBe("Upstash Redis");

        // 验证最后一次调用是发给 Upstash 的
        const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        expect(lastCall[0]).toContain("mock-upstash.com");
    });

    test("should use Upstash after failover", async () => {
        // 手动设置状态为已切换
        kvInstance.currentProvider = 'upstash';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ result: "value" })
        });

        await kvInstance.get("key");

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toContain("mock-upstash.com");
    });

    test("should trigger failover on network errors", async () => {
        // 模拟网络错误
        const networkErrorResponse = new Error("fetch failed");

        // 第一次失败
        mockFetch.mockRejectedValueOnce(networkErrorResponse);
        await expect(kvInstance.set("k1", "v1")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(1);

        // 第二次失败
        mockFetch.mockRejectedValueOnce(networkErrorResponse);
        await expect(kvInstance.set("k2", "v2")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(2);

        // 第三次失败 -> 触发切换 -> 重试成功
        mockFetch.mockRejectedValueOnce(networkErrorResponse); // CF 失败
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) }); // Upstash 成功

        await kvInstance.set("k3", "v3");

        expect(kvInstance.failureCount).toBe(0);
        expect(kvInstance.getCurrentProvider()).toBe("Upstash Redis");
    });

    test("should trigger failover on timeout errors", async () => {
        // 模拟超时错误
        const timeoutErrorResponse = new Error("network timeout");

        // 第一次失败
        mockFetch.mockRejectedValueOnce(timeoutErrorResponse);
        await expect(kvInstance.set("k1", "v1")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(1);

        // 第二次失败
        mockFetch.mockRejectedValueOnce(timeoutErrorResponse);
        await expect(kvInstance.set("k2", "v2")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(2);

        // 第三次失败 -> 触发切换 -> 重试成功
        mockFetch.mockRejectedValueOnce(timeoutErrorResponse); // CF 失败
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) }); // Upstash 成功

        await kvInstance.set("k3", "v3");

        expect(kvInstance.failureCount).toBe(0);
        expect(kvInstance.getCurrentProvider()).toBe("Upstash Redis");
    });

    test("should maintain failover state across operations", async () => {
        // 触发故障转移
        const quotaErrorResponse = {
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        };

        // 快速连续失败 3 次
        for (let i = 0; i < 3; i++) {
            mockFetch.mockResolvedValueOnce(quotaErrorResponse);
            await expect(kvInstance.set(`k${i}`, `v${i}`)).rejects.toThrow();
        }

        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "OK" }) });
        await kvInstance.set("k3", "v3");

        expect(kvInstance.getCurrentProvider()).toBe("Upstash Redis");

        // 后续操作应该继续使用 Upstash
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ result: "value" }) });
        await kvInstance.get("key");

        expect(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]).toContain("mock-upstash.com");
    });

    test("should reset failure count after successful operation", async () => {
        // 先失败一次
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        });
        await expect(kvInstance.set("k1", "v1")).rejects.toThrow();
        expect(kvInstance.failureCount).toBe(1);

        // 成功操作不重置计数（仅故障转移时重置）
        mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ success: true }) });
        await kvInstance.set("k2", "v2");
        expect(kvInstance.failureCount).toBe(1);
        expect(kvInstance.getCurrentProvider()).toBe("Cloudflare KV");
    });

    test("should not failover if Upstash not configured", async () => {
        // 临时修改配置，模拟没有 Upstash
        kvInstance.hasUpstash = false;
        kvInstance.failoverEnabled = false;

        const quotaErrorResponse = {
            json: () => Promise.resolve({ success: false, errors: [{ message: "free usage limit exceeded" }] })
        };

        // 连续失败多次
        for (let i = 0; i < 5; i++) {
            mockFetch.mockResolvedValueOnce(quotaErrorResponse);
            await expect(kvInstance.set(`k${i}`, `v${i}`)).rejects.toThrow();
        }

        // 应该保持使用 Cloudflare KV，不切换
        expect(kvInstance.getCurrentProvider()).toBe("Cloudflare KV");
        // 如果未启用故障转移，failureCount 不会增加
        expect(kvInstance.failureCount).toBe(0);

        // 恢复配置
        kvInstance.hasUpstash = true;
        kvInstance.failoverEnabled = true;
    });

    test("should correctly identify failover mode", () => {
        // 默认状态
        kvInstance.currentProvider = 'cloudflare';
        expect(kvInstance.isFailoverMode).toBe(false);

        // 切换到 Upstash
        kvInstance.currentProvider = 'upstash';
        expect(kvInstance.isFailoverMode).toBe(true);

        // 强制设置为 Upstash（通过环境变量）
        process.env.KV_PROVIDER = 'upstash';
        kvInstance.currentProvider = 'upstash';
        expect(kvInstance.isFailoverMode).toBe(false); // 不是故障转移，是强制配置

        process.env.KV_PROVIDER = 'cloudflare';
    });
});