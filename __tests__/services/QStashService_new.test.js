import { jest } from "@jest/globals";

// Mock dependencies
const mockPublishJSON = jest.fn();
const mockClient = {
    publishJSON: mockPublishJSON
};

const mockVerify = jest.fn();
const mockReceiver = {
    verify: mockVerify
};

const mockConfig = {
    qstash: {
        token: 'test-token',
        webhookUrl: 'https://example.com'
    }
};

// Mock modules
jest.unstable_mockModule("@upstash/qstash", () => ({
    Client: jest.fn(() => mockClient),
    Receiver: jest.fn(() => mockReceiver)
}));

jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: mockConfig
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

describe("QStashService - Retry Logic", () => {
    let QStashService;
    let qstashService;
    let setTimeoutSpy;

    beforeAll(async () => {
        const module = await import("../../src/services/QStashService.js");
        QStashService = module.QStashService;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock setTimeout to execute immediately to speed up tests
        setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
            fn();
            return {};
        });
        // Create a fresh instance for each test
        qstashService = new QStashService();
    });

    afterEach(() => {
        setTimeoutSpy.mockRestore();
    });

    describe("publish - Retry Logic", () => {
        test("应当在失败后重试并最终成功", async () => {
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error"))
                .mockRejectedValueOnce(new Error("Network error"))
                .mockResolvedValueOnce({ messageId: "msg-123" });

            const result = await qstashService.publish("download-tasks", { taskId: "123" });

            expect(mockPublishJSON).toHaveBeenCalledTimes(3);
            expect(result).toEqual({ messageId: "msg-123" });
        });

        test("应当在 4xx 错误时不重试", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("400 Bad Request"));

            await expect(qstashService.publish("download-tasks", { taskId: "123" }))
                .rejects.toThrow("400 Bad Request");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当在达到最大重试次数后抛出错误", async () => {
            mockPublishJSON.mockRejectedValue(new Error("Persistent failure"));

            await expect(qstashService.publish("download-tasks", { taskId: "123" }))
                .rejects.toThrow("Persistent failure");

            expect(mockPublishJSON).toHaveBeenCalledTimes(3);
        });

        test("应当在第一次尝试成功时不重试", async () => {
            mockPublishJSON.mockResolvedValueOnce({ messageId: "msg-456" });

            const result = await qstashService.publish("download-tasks", { taskId: "123" });

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ messageId: "msg-456" });
        });

        test("应当正确处理 401 错误（不重试）", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("401 Unauthorized"));

            await expect(qstashService.publish("download-tasks", { taskId: "123" }))
                .rejects.toThrow("401 Unauthorized");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当正确处理 403 错误（不重试）", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("403 Forbidden"));

            await expect(qstashService.publish("download-tasks", { taskId: "123" }))
                .rejects.toThrow("403 Forbidden");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当正确处理 422 错误（不重试）", async () => {
            mockPublishJSON.mockRejectedValueOnce(new Error("422 Unprocessable Entity"));

            await expect(qstashService.publish("download-tasks", { taskId: "123" }))
                .rejects.toThrow("422 Unprocessable Entity");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });
    });

    describe("batchPublish - Retry Logic", () => {
        test("应当在失败后重试并最终成功", async () => {
            const messages = [
                { topic: "download-tasks", message: { taskId: "123" } },
                { topic: "upload-tasks", message: { taskId: "456" } }
            ];

            // First attempt: both fail
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error"))
                .mockRejectedValueOnce(new Error("Network error"))
                // Second attempt: both fail
                .mockRejectedValueOnce(new Error("Network error"))
                .mockRejectedValueOnce(new Error("Network error"))
                // Third attempt: both succeed
                .mockResolvedValueOnce({ messageId: "msg-123" })
                .mockResolvedValueOnce({ messageId: "msg-456" });

            const results = await qstashService.batchPublish(messages);

            expect(mockPublishJSON).toHaveBeenCalledTimes(6);
            expect(results).toEqual([
                { status: 'fulfilled', value: { messageId: "msg-123" } },
                { status: 'fulfilled', value: { messageId: "msg-456" } }
            ]);
        });

        test("应当在 4xx 错误时不重试", async () => {
            const messages = [
                { topic: "download-tasks", message: { taskId: "123" } }
            ];

            mockPublishJSON.mockRejectedValueOnce(new Error("400 Bad Request"));

            await expect(qstashService.batchPublish(messages))
                .rejects.toThrow("400 Bad Request");

            expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        });

        test("应当在达到最大重试次数后抛出错误", async () => {
            const messages = [
                { topic: "download-tasks", message: { taskId: "123" } }
            ];

            mockPublishJSON.mockRejectedValue(new Error("Persistent failure"));

            await expect(qstashService.batchPublish(messages))
                .rejects.toThrow("Persistent failure");

            expect(mockPublishJSON).toHaveBeenCalledTimes(3);
        });
    });

    describe("enqueueDownloadTask - Uses Retry", () => {
        test("应当使用重试逻辑", async () => {
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error"))
                .mockResolvedValueOnce({ messageId: "msg-123" });

            const result = await qstashService.enqueueDownloadTask("123", { userId: "user1" });

            expect(mockPublishJSON).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ messageId: "msg-123" });
        });
    });

    describe("enqueueUploadTask - Uses Retry", () => {
        test("应当使用重试逻辑", async () => {
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error"))
                .mockResolvedValueOnce({ messageId: "msg-456" });

            const result = await qstashService.enqueueUploadTask("456", { userId: "user2" });

            expect(mockPublishJSON).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ messageId: "msg-456" });
        });
    });

    describe("broadcastSystemEvent - Uses Retry", () => {
        test("应当使用重试逻辑", async () => {
            mockPublishJSON
                .mockRejectedValueOnce(new Error("Network error"))
                .mockResolvedValueOnce({ messageId: "msg-event" });

            const result = await qstashService.broadcastSystemEvent("test-event", { data: "test" });

            expect(mockPublishJSON).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ messageId: "msg-event" });
        });
    });

    describe("Mock Mode", () => {
        let mockQStashService;
        let originalToken;

        beforeAll(() => {
            // Save original token
            originalToken = mockConfig.qstash.token;
            // Set token to empty to enable mock mode
            mockConfig.qstash.token = '';
        });

        afterAll(() => {
            // Restore original token
            mockConfig.qstash.token = originalToken;
        });

        beforeEach(() => {
            // Create a new instance with mock mode
            mockQStashService = new QStashService();
        });

        test("应当在模拟模式下跳过重试", async () => {
            const result = await mockQStashService.publish("download-tasks", { taskId: "123" });
            expect(result).toEqual({ messageId: "mock-message-id" });
            expect(mockPublishJSON).not.toHaveBeenCalled();
        });

        test("应当在模拟模式下批量发布", async () => {
            const messages = [
                { topic: "download-tasks", message: { taskId: "123" } },
                { topic: "upload-tasks", message: { taskId: "456" } }
            ];
            const results = await mockQStashService.batchPublish(messages);
            expect(results).toEqual([
                { status: "fulfilled", value: { messageId: "mock-message-id" } },
                { status: "fulfilled", value: { messageId: "mock-message-id" } }
            ]);
        });
    });
});
