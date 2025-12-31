import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

// Mock logger
const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.unstable_mockModule("../../src/services/logger.js", () => ({
    default: mockLogger,
    logger: mockLogger
}));

describe("D1 Service Resilience and Retry Mechanisms", () => {
    let d1Instance;

    beforeEach(async () => {
        // Set up mock environment variables - 使用新的变量名
        process.env = {
            ...originalEnv,
            CF_D1_ACCOUNT_ID: "test_account",
            CF_D1_DATABASE_ID: "test_db",
            CF_D1_TOKEN: "test_token",
        };
        jest.useFakeTimers();
        jest.resetModules();

        // Dynamically import d1 after setting up mocks
        const { d1: importedD1 } = await import("../../src/services/d1.js");
        d1Instance = importedD1;
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test("should retry on network connection errors", async () => {
        // Mock fetch to fail twice with network error, then succeed
        mockFetch
            .mockRejectedValueOnce(new TypeError("Failed to fetch")) // Network error
            .mockRejectedValueOnce(new TypeError("Network timeout")) // Network error
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    success: true,
                    result: [{ results: [{ id: 1 }] }]
                })
            });

        const promise = d1Instance.fetchAll("SELECT * FROM test");
        await jest.advanceTimersByTimeAsync(10000); // Advance for retry delays
        const result = await promise;

        expect(mockFetch).toHaveBeenCalledTimes(3); // 2 failures + 1 success
        expect(result).toEqual([{ id: 1 }]);
    });

    test("should retry on HTTP 500 errors", async () => {
        // Mock fetch to return 500 twice, then succeed
        mockFetch
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: "Internal Server Error",
                text: () => Promise.resolve("Server error")
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 502,
                statusText: "Bad Gateway",
                text: () => Promise.resolve("Bad gateway")
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    success: true,
                    result: [{ results: [{ status: "ok" }] }]
                })
            });

        const promise = d1Instance.run("UPDATE test SET status = ?", ["ok"]);
        await jest.advanceTimersByTimeAsync(10000); // Advance for retry delays
        const result = await promise;

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(result).toEqual({ status: "ok" });
    });

    test("should retry on D1 'Network connection lost' (Code 7500)", async () => {
        // Mock fetch to return 7500 error twice, then succeed
        mockFetch
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: () => Promise.resolve('{"errors":[{"code":7500,"message":"Network connection lost."}],"success":false}')
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: () => Promise.resolve('{"errors":[{"code":7500,"message":"Network connection lost."}],"success":false}')
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    success: true,
                    result: [{ changes: 1 }]
                })
            });

        const promise = d1Instance.run("DELETE FROM test WHERE id = ?", [1]);
        await jest.advanceTimersByTimeAsync(10000); // Advance for retry delays
        const result = await promise;

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(result).toEqual({ changes: 1 });
    });

    test("should fail after max retries exhausted", async () => {
        // Mock fetch to always fail with network errors
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

        const promise = expect(d1Instance.fetchOne("SELECT * FROM test WHERE id = ?", [1]))
            .rejects.toThrow("D1 Error: Network connection lost (Max retries exceeded)");
        await jest.advanceTimersByTimeAsync(10000); // Advance for retry delays
        await promise;

        expect(mockFetch).toHaveBeenCalledTimes(3); // Max 3 attempts
    });

    test("should not retry on client errors (4xx except 400 with 7500)", async () => {
        // Mock fetch to return 403 Forbidden - should not retry
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: () => Promise.resolve("Access denied")
        });

        await expect(d1Instance.run("SELECT * FROM restricted"))
            .rejects.toThrow("HTTP 403: Forbidden");

        expect(mockFetch).toHaveBeenCalledTimes(1); // No retry for 403
    });

    test("should handle configuration missing gracefully", async () => {
        // Temporarily remove required env vars
        const originalAccountId = process.env.CF_D1_ACCOUNT_ID;
        const originalDbId = process.env.CF_D1_DATABASE_ID;

        delete process.env.CF_D1_ACCOUNT_ID;
        delete process.env.CF_D1_DATABASE_ID;

        // Re-import to get new instance without config
        jest.resetModules();
        const { d1: badD1Instance } = await import("../../src/services/d1.js");

        await expect(badD1Instance.fetchAll("SELECT 1"))
            .rejects.toThrow("D1 Error: Missing configuration");

        expect(mockFetch).not.toHaveBeenCalled(); // Should not attempt request

        // Restore env vars
        process.env.CF_D1_ACCOUNT_ID = originalAccountId;
        process.env.CF_D1_DATABASE_ID = originalDbId;
    });

    test("should provide detailed error logging for debugging", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: () => Promise.resolve('{"errors":[{"message":"Invalid SQL syntax"}]}')
        });

        // Re-import to get updated mock
        jest.resetModules();
        const { d1: newD1Instance } = await import("../../src/services/d1.js");
        const { default: logger } = await import("../../src/services/logger.js");

        await expect(newD1Instance.run("INVALID SQL"))
            .rejects.toThrow("HTTP 400: Bad Request");

        // Check that detailed error info was logged
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("🚨 D1 HTTP Error"),
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("URL: https://api.cloudflare.com")
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Response: {"errors":[{"message":"Invalid SQL syntax"}]}')
        );
    });

    test("should maintain linear backoff timing", async () => {
        let callCount = 0;
        mockFetch.mockImplementation(() => {
            callCount++;
            if (callCount < 3) {
                return Promise.resolve({
                    ok: false,
                    status: 500,
                    statusText: "Internal Server Error",
                    text: () => Promise.resolve("Server error")
                });
            } else {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        success: true,
                        result: [{ success: true }]
                    })
                });
            }
        });

        const promise = d1Instance.run("SELECT 1");

        // Advance timers for retry delays: 2s, then 4s
        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(4000);

        const result = await promise;

        expect(callCount).toBe(3); // 2 retries + 1 success
        expect(result).toEqual({ success: true });
    });
});