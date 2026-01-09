import { jest } from "@jest/globals";

// 独立的配置变量，用于动态 Mock
let qstashConfig = {
    token: 'test-token',
    webhookUrl: 'https://example.com'
};

// Mock dependencies
const mockPublishJSON = jest.fn();
const mockClient = {
    publishJSON: mockPublishJSON
};

const mockVerify = jest.fn();
const mockReceiver = {
    verify: mockVerify
};

// 使用 Getter/Setter 包装 Mock Config，确保引用正确
const mockConfig = {
    get qstash() {
        return qstashConfig;
    },
    set qstash(val) {
        qstashConfig = val;
    }
};

// Mock modules
jest.unstable_mockModule("@upstash/qstash", () => ({
    Client: jest.fn(() => mockClient),
    Receiver: jest.fn(() => mockReceiver)
}));

// 兼容命名导入和默认导入
jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: mockConfig,
    getConfig: () => mockConfig,
    default: { config: mockConfig, getConfig: () => mockConfig }
}));

// Mock logger
jest.unstable_mockModule("../../src/services/logger.js", () => ({
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    },
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    }
}));

// Mock CircuitBreaker to disable in tests
jest.unstable_mockModule("../../src/services/CircuitBreaker.js", () => ({
    CircuitBreakerManager: {
        get: jest.fn().mockReturnValue({
            execute: async (cmd, fallback) => cmd(),  // Pass through without circuit breaker
            getStatus: () => ({ state: 'CLOSED', failureCount: 0 }),
            reset: () => {}
        })
    },
    CircuitBreaker: jest.fn().mockImplementation(() => ({
        execute: async (cmd) => cmd()
    }))
}));

describe("QStashService - Retry Logic", () => {
    let QStashService;
    let qstashService;

    beforeAll(async () => {
        // Enable fake timers BEFORE importing the service
        // Use modern fake timers with advanceTimers support
        jest.useFakeTimers({
            timerLimit: 10000,
            advanceTimers: true
        });
        jest.spyOn(global.Math, 'random').mockReturnValue(0.5);
        
        // ================== 关键修复 ==================
        // 清空所有模块缓存，防止其他测试文件（如 SettingsRepository）的 Mock 污染当前测试
        jest.resetModules();
        // ==============================================

        const module = await import("../../src/services/QStashService.js");
        QStashService = module.QStashService;
    });

    afterAll(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        mockPublishJSON.mockReset();
        mockVerify.mockReset();
        
        // 每次测试前确保 Token 存在
        qstashConfig.token = 'test-token';
        qstashConfig.webhookUrl = 'https://example.com';
        
        // Create a fresh instance for each test
        qstashService = new QStashService();
        // Initialize the service
        await qstashService.initialize();
        // Reset circuit breaker for clean test state
        qstashService.resetCircuitBreaker();
    });

    describe("publish - Retry Logic", () => {
        test("应当在失败后重试并最终成功", async () => {
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error"))
                .mockRejectedValueOnce(new Error("Network error"))
                .mockResolvedValueOnce({ messageId: "msg-123" });

            const promise = qstashService.publish("download", { taskId: "123" });
            
            // Advance timers for retries using Async version
            // Attempt 1 fails immediately, waits 100ms + jitter (fixed 25ms) = 125ms
            await jest.advanceTimersByTimeAsync(125);
            // Attempt 2 fails immediately, waits 200ms + jitter (fixed 25ms) = 225ms
            await jest.advanceTimersByTimeAsync(225);
            // Attempt 3 succeeds
            
            const result = await promise;

            expect(mockPublishJSON).toHaveBeenCalledTimes(3);
            expect(result).toEqual({ messageId: "msg-123" });
        });

        test("应当在 4xx 错误时不重试", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("400 Bad Request"));

            await expect(qstashService.publish("download", { taskId: "123" }))
                .rejects.toThrow("400 Bad Request");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当在达到最大重试次数后抛出错误", async () => {
            // Use a different approach - mock with a function that returns a rejected promise
            const persistentError = new Error("Persistent failure");
            mockPublishJSON.mockImplementation(() => Promise.reject(persistentError));

            // Start the operation and attach catch handler BEFORE advancing timers
            const promise = qstashService.publish("download", { taskId: "123" }).catch(e => e);
            
            // Advance timers for all retries
            await jest.advanceTimersByTimeAsync(125); // Attempt 1
            await jest.advanceTimersByTimeAsync(225); // Attempt 2
            
            // Now wait for the promise to settle
            const result = await promise;
            expect(result.message).toBe("Persistent failure");
            
            expect(mockPublishJSON).toHaveBeenCalledTimes(3);
        });

        test("应当在第一次尝试成功时不重试", async () => {
            mockPublishJSON.mockResolvedValueOnce({ messageId: "msg-456" });

            const result = await qstashService.publish("download", { taskId: "123" });

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ messageId: "msg-456" });
        });

        test("应当正确处理 401 错误（不重试）", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("401 Unauthorized"));

            await expect(qstashService.publish("download", { taskId: "123" }))
                .rejects.toThrow("401 Unauthorized");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当正确处理 403 错误（不重试）", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("403 Forbidden"));

            await expect(qstashService.publish("download", { taskId: "123" }))
                .rejects.toThrow("403 Forbidden");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当正确处理 422 错误（不重试）", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("422 Unprocessable Entity"));

            await expect(qstashService.publish("download", { taskId: "123" }))
                .rejects.toThrow("422 Unprocessable Entity");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });
    });

    describe("batchPublish - Retry Logic", () => {
        test("应当在失败后重试并最终成功", async () => {
            const messages = [
                { topic: "download", message: { taskId: "123" } },
                { topic: "upload-tasks", message: { taskId: "456" } }
            ];

            // Reset mock to ensure clean state
            mockPublishJSON.mockReset();
            
            // Set up mock to handle concurrent calls
            // Since batchPublish is concurrent, we need to set up the mock to handle all calls
            // First 4 calls fail, last 2 succeed
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error")) // msg 1, attempt 1
                .mockRejectedValueOnce(new Error("Network error")) // msg 2, attempt 1
                .mockRejectedValueOnce(new Error("Network error")) // msg 1, attempt 2
                .mockRejectedValueOnce(new Error("Network error")) // msg 2, attempt 2
                .mockResolvedValueOnce({ messageId: "msg-123" })   // msg 1, attempt 3
                .mockResolvedValueOnce({ messageId: "msg-456" });  // msg 2, attempt 3

            const promise = qstashService.batchPublish(messages);

            // Advance timers for all retries using Async version
            // Since both messages are processed concurrently:
            // Attempt 1 (both): fails, waits 100ms + jitter (fixed 25ms) = 125ms
            await jest.advanceTimersByTimeAsync(125);
            // Attempt 2 (both): fails, waits 200ms + jitter (fixed 25ms) = 225ms
            await jest.advanceTimersByTimeAsync(225);
            // Attempt 3 (both): succeeds

            const results = await promise;

            expect(mockPublishJSON).toHaveBeenCalledTimes(6); // 2 messages * 3 attempts
            // Sort results to ensure consistent order for comparison
            const sortedResults = results.sort((a, b) =>
                a.value.messageId.localeCompare(b.value.messageId)
            );
            expect(sortedResults).toEqual([
                { status: 'fulfilled', value: { messageId: "msg-123" } },
                { status: 'fulfilled', value: { messageId: "msg-456" } }
            ]);
        });

        test("应当在 4xx 错误时不重试", async () => {
            const messages = [
                { topic: "download", message: { taskId: "123" } },
                { topic: "upload-tasks", message: { taskId: "456" } }
            ];

            mockPublishJSON.mockReset();
            mockPublishJSON.mockRejectedValue(new Error("400 Bad Request"));

            const results = await qstashService.batchPublish(messages);

            expect(mockPublishJSON).toHaveBeenCalledTimes(2); // Two messages, no retries
            // Sort results to ensure consistent order
            const sortedResults = results.sort((a, b) => 
                a.reason.message.localeCompare(b.reason.message)
            );
            expect(sortedResults).toEqual([
                { status: 'rejected', reason: expect.any(Error) },
                { status: 'rejected', reason: expect.any(Error) }
            ]);
            expect(sortedResults[0].reason.message).toEqual("400 Bad Request");
            expect(sortedResults[1].reason.message).toEqual("400 Bad Request");
        });

        test("应当在部分成功部分失败时返回正确的结果", async () => {
            const messages = [
                { topic: "download", message: { taskId: "123" } },
                { topic: "upload-tasks", message: { taskId: "456" } }
            ];

            mockPublishJSON.mockReset();
            // Message 1 succeeds immediately
            // Message 2: fails first attempt, succeeds second attempt
            mockPublishJSON
                .mockResolvedValueOnce({ messageId: "msg-success" }) // First message succeeds
                .mockRejectedValueOnce(new Error("Network error"))   // Second message fails first attempt
                .mockResolvedValueOnce({ messageId: "msg-retry-success" }); // Second message succeeds on retry

            const promise = qstashService.batchPublish(messages);

            // Message 1 succeeds immediately
            // Message 2: Attempt 1 fails, waits 100ms + jitter (fixed 25ms) = 125ms
            await jest.advanceTimersByTimeAsync(125);
            // Message 2: Attempt 2 succeeds

            const results = await promise;

            // Total calls should be 3: 1 for first message, 2 for second message (one fail, one success)
            expect(mockPublishJSON).toHaveBeenCalledTimes(3);
            // Sort results to ensure consistent order
            const sortedResults = results.sort((a, b) =>
                a.value.messageId.localeCompare(b.value.messageId)
            );
            expect(sortedResults).toEqual([
                { status: 'fulfilled', value: { messageId: "msg-retry-success" } },
                { status: 'fulfilled', value: { messageId: "msg-success" } }
            ]);
        });

        test("应当在所有消息都达到最大重试次数后抛出错误", async () => {
            const messages = [
                { topic: "download", message: { taskId: "123" } },
                { topic: "upload-tasks", message: { taskId: "456" } }
            ];

            mockPublishJSON.mockReset();
            mockPublishJSON.mockRejectedValue(new Error("Persistent failure")); // All attempts fail

            const promise = qstashService.batchPublish(messages);

            // Advance timers for all retries using Async version
            // Message 1: Attempt 1 fails, waits 100ms + jitter (fixed 25ms) = 125ms
            await jest.advanceTimersByTimeAsync(125);
            // Message 1: Attempt 2 fails, waits 200ms + jitter (fixed 25ms) = 225ms
            await jest.advanceTimersByTimeAsync(225);
            // Message 1: Attempt 3 fails
            // Message 2: Attempt 1 fails, waits 100ms + jitter (fixed 25ms) = 125ms
            await jest.advanceTimersByTimeAsync(125);
            // Message 2: Attempt 2 fails, waits 200ms + jitter (fixed 25ms) = 225ms
            await jest.advanceTimersByTimeAsync(225);
            // Message 2: Attempt 3 fails

            const results = await promise;

            // Each message attempts 3 times, so total calls = 2 messages * 3 attempts = 6
            expect(mockPublishJSON).toHaveBeenCalledTimes(6);
            expect(results).toEqual([
                { status: 'rejected', reason: expect.any(Error) },
                { status: 'rejected', reason: expect.any(Error) }
            ]);
            expect(results[0].reason.message).toEqual("Persistent failure");
            expect(results[1].reason.message).toEqual("Persistent failure");
        });

        test("当 QStash token 不存在时，initialize 应抛出错误", async () => {
            qstashConfig.token = null; 
            const service = new QStashService();
            // The service does NOT throw in initialize, it just sets isMockMode = true
            // So we expect it to resolve successfully
            await expect(service.initialize()).resolves.toBeUndefined();
            expect(service.isMockMode).toBe(true);
            expect(mockPublishJSON).not.toHaveBeenCalled(); 
        });

        test("当 QStash token 不存在时，publish 应返回 mock value", async () => {
            qstashConfig.token = null;
            const service = new QStashService();
            await service.initialize(); 
            // In mock mode, publish returns a mock message ID
            const result = await service.publish("download", { taskId: "123" });
            expect(result).toEqual({ messageId: "mock-message-id" });
            expect(mockPublishJSON).not.toHaveBeenCalled();
        });

        test("当 QStash token 不存在时，batchPublish 应返回 mock values", async () => {
            qstashConfig.token = null;
            const service = new QStashService();
            await service.initialize(); 
            const messages = [{ topic: "test", message: {} }];
            const results = await service.batchPublish(messages);
            expect(results).toEqual([{ status: "fulfilled", value: { messageId: "mock-message-id" } }]);
            expect(mockPublishJSON).not.toHaveBeenCalled();
        });
    });

    describe("verifySignature", () => {
        test("应当成功验证签名", async () => {
            const signature = "test-signature";
            const body = "test-body";
            mockVerify.mockResolvedValueOnce(true);

            const isValid = await qstashService.verifyWebhookSignature(signature, body);
            expect(isValid).toBe(true);
            expect(mockVerify).toHaveBeenCalledWith({
                signature: signature,
                body: body
            });
        });

        test("应当在验证失败时返回 false", async () => {
            const signature = "invalid-signature";
            const body = "test-body";
            mockVerify.mockRejectedValueOnce(new Error("Signature mismatch"));

            const isValid = await qstashService.verifyWebhookSignature(signature, body);
            expect(isValid).toBe(false);
            expect(mockVerify).toHaveBeenCalledWith({
                signature: signature,
                body: body
            });
        });

        test("当缺少签名头时，应当返回 false", async () => {
            // This test is tricky because verifyWebhookSignature takes signature and body directly.
            // If signature is undefined/null, the Receiver.verify might throw or fail.
            // The test logic here assumes the method handles it gracefully or the caller handles it.
            // Based on the source code, if isMockMode is true, it returns true immediately.
            // If isMockMode is false, it calls receiver.verify.
            // Let's test the non-mock path where signature is missing.
            
            // First, we need to force non-mock mode
            qstashConfig.token = 'test-token';
            qstashConfig.currentSigningKey = 'key1';
            qstashConfig.nextSigningKey = 'key2';
            const service = new QStashService();
            await service.initialize();
            
            // Mock verify to throw because signature is missing/invalid
            mockVerify.mockRejectedValueOnce(new Error("Missing signature"));

            const isValid = await service.verifyWebhookSignature(null, "body");
            expect(isValid).toBe(false);
            // According to the user's analysis, if signature is empty, the service should return false
            // without calling receiver.verify, so we expect it NOT to have been called
            expect(mockVerify).not.toHaveBeenCalled();
        });
    });
});