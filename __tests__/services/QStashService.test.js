import { jest } from "@jest/globals";

// Mock crypto first
const mockDigest = jest.fn().mockReturnValue("mock_digest");
const mockUpdate = jest.fn().mockReturnThis();
const mockHmac = { update: mockUpdate, digest: mockDigest };
const mockCreateHmac = jest.fn(() => mockHmac);

jest.unstable_mockModule("crypto", () => ({
    default: {
        createHmac: mockCreateHmac
    }
}));

// Mock @upstash/qstash
const mockPublishJSON = jest.fn();
const MockClient = class {
    constructor() {
        this.publishJSON = mockPublishJSON;
    }
};

jest.unstable_mockModule("@upstash/qstash", () => ({
    Client: MockClient
}));

// Mock config
jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: {
        qstash: {
            token: "mock_token",
            webhookUrl: "https://example.com"
        }
    }
}));

describe("QStashService", () => {
    let service;

    describe("正常模式 (with token)", () => {
        beforeEach(async () => {
            jest.clearAllMocks();
            // Set up default mocks
            mockPublishJSON.mockResolvedValue({ messageId: "test-id" });
            mockDigest.mockReturnValue("mock_digest");
            mockUpdate.mockReturnValue(mockHmac);
            mockCreateHmac.mockReturnValue(mockHmac);
            process.env.QSTASH_WEBHOOK_SECRET = "secret";
            const module = await import("../../src/services/QStashService.js");
            service = new module.QStashService();
        });

        test("publish 应该正确调用 client.publishJSON", async () => {
            const topic = "download-tasks";
            const message = { taskId: "123" };
            const options = { delay: 10 };

            await service.publish(topic, message, options);

            expect(mockPublishJSON).toHaveBeenCalledWith({
                url: "https://example.com/api/tasks/download-tasks",
                body: JSON.stringify(message),
                headers: {
                    "Content-Type": "application/json"
                },
                ...options
            });
        });

        test("batchPublish 应该使用 Promise.allSettled", async () => {
            const messages = [
                { topic: "download-tasks", message: { taskId: "1" } },
                { topic: "upload-tasks", message: { taskId: "2" } }
            ];

            mockPublishJSON.mockResolvedValueOnce({ messageId: "1" });
            mockPublishJSON.mockRejectedValueOnce(new Error("fail"));

            const results = await service.batchPublish(messages);

            expect(results).toHaveLength(2);
            expect(results[0].status).toBe("fulfilled");
            expect(results[1].status).toBe("rejected");
        });

        test("publishDelayed 应该添加 delay 选项", async () => {
            const topic = "media-batch";
            const message = { groupId: "group1" };
            const delaySeconds = 5;

            await service.publishDelayed(topic, message, delaySeconds);

            expect(mockPublishJSON).toHaveBeenCalledWith({
                url: "https://example.com/api/tasks/media-batch",
                body: JSON.stringify(message),
                headers: {
                    "Content-Type": "application/json"
                },
                delay: delaySeconds
            });
        });

        test("verifyWebhookSignature 匹配时返回 true", () => {
            process.env.QSTASH_WEBHOOK_SECRET = "secret";
            const signature = "v1=mock_digest";
            const body = "test body";

            const result = service.verifyWebhookSignature(signature, body);

            expect(result).toBe(true);
            expect(mockCreateHmac).toHaveBeenCalledWith("sha256", "secret");
            expect(mockUpdate).toHaveBeenCalledWith(body, "utf8");
            expect(mockDigest).toHaveBeenCalledWith("hex");
        });

        test("verifyWebhookSignature 不匹配时返回 false", () => {
            process.env.QSTASH_WEBHOOK_SECRET = "secret";
            const signature = "v1=wrong_digest";
            const body = "test body";

            const result = service.verifyWebhookSignature(signature, body);

            expect(result).toBe(false);
        });

        test("enqueueDownloadTask 调用 publish", async () => {
            await service.enqueueDownloadTask("123", { data: "extra" });

            expect(mockPublishJSON).toHaveBeenCalledWith({
                url: "https://example.com/api/tasks/download-tasks",
                body: JSON.stringify({
                    taskId: "123",
                    type: "download",
                    data: "extra"
                }),
                headers: {
                    "Content-Type": "application/json"
                }
            });
        });

        test("scheduleMediaGroupBatch 调用 publishDelayed", async () => {
            await service.scheduleMediaGroupBatch("group1", ["1", "2"], 2);

            expect(mockPublishJSON).toHaveBeenCalledWith({
                url: "https://example.com/api/tasks/media-batch",
                body: JSON.stringify({
                    groupId: "group1",
                    taskIds: ["1", "2"],
                    type: "media-group-batch"
                }),
                headers: {
                    "Content-Type": "application/json"
                },
                delay: 2
            });
        });
    });

    describe("Mock 模式 (without token)", () => {
        beforeAll(() => {
            // Temporarily remove token
            jest.unstable_mockModule("../../src/config/index.js", () => ({
                config: {
                    qstash: null
                }
            }));
        });

        beforeEach(async () => {
            jest.clearAllMocks();
            mockPublishJSON.mockResolvedValue({ messageId: "test-id" });
            mockDigest.mockReturnValue("mock_digest");
            mockUpdate.mockReturnValue(mockHmac);
            mockCreateHmac.mockReturnValue(mockHmac);
            const module = await import("../../src/services/QStashService.js");
            service = new module.QStashService();
            service.isMockMode = true; // Force mock mode
        });

        test("Mock 模式下 publish 返回 mock 结果", async () => {
            const result = await service.publish("topic", {});

            expect(result).toEqual({ messageId: "mock-message-id" });
            expect(mockPublishJSON).not.toHaveBeenCalled();
        });

        test("Mock 模式下 batchPublish 返回结果数组", async () => {
            const messages = [
                { topic: "download-tasks", message: {} },
                { topic: "upload-tasks", message: {} }
            ];

            const results = await service.batchPublish(messages);

            expect(results).toHaveLength(2);
            expect(results[0].status).toBe("fulfilled");
            expect(results[1].status).toBe("fulfilled");
            expect(mockPublishJSON).not.toHaveBeenCalled();
        });

        test("Mock 模式下 verifyWebhookSignature 返回 true", () => {
            const result = service.verifyWebhookSignature("sig", "body");

            expect(result).toBe(true);
        });
    });

    describe("错误处理", () => {
        beforeEach(async () => {
            jest.clearAllMocks();
            mockPublishJSON.mockResolvedValue({ messageId: "test-id" });
            mockDigest.mockReturnValue("mock_digest");
            mockUpdate.mockReturnValue(mockHmac);
            mockCreateHmac.mockReturnValue(mockHmac);
            const module = await import("../../src/services/QStashService.js");
            service = new module.QStashService();
        });

        test("publish 抛出异常时重新抛出", async () => {
            mockPublishJSON.mockRejectedValue(new Error("network error"));

            await expect(service.publish("topic", {})).rejects.toThrow("network error");
        });

        test("batchPublish 部分失败时日志警告", async () => {
            const messages = [
                { topic: "download-tasks", message: {} },
                { topic: "upload-tasks", message: {} }
            ];

            mockPublishJSON.mockResolvedValueOnce({});
            mockPublishJSON.mockRejectedValueOnce(new Error("fail"));

            const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

            await service.batchPublish(messages);

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });
});