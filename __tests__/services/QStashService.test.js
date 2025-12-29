import { jest } from "@jest/globals";
import { mockQstashPublish, mockQstashVerify } from '../setup/external-mocks.js';

// Use the global mock
const mockPublishJSON = mockQstashPublish;
const mockVerify = mockQstashVerify;

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

    beforeEach(async () => {
        jest.clearAllMocks();
        // Set up default mocks
        mockPublishJSON.mockResolvedValue({ messageId: "test-id" });
        mockVerify.mockResolvedValue(undefined);
        process.env.QSTASH_CURRENT_SIGNING_KEY = "current_key";
        process.env.QSTASH_NEXT_SIGNING_KEY = "next_key";
        
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

    test("verifyWebhookSignature 验证成功时返回 true", async () => {
        const signature = "valid_signature";
        const body = "test body";

        const result = await service.verifyWebhookSignature(signature, body);

        expect(result).toBe(true);
        expect(mockVerify).toHaveBeenCalledWith({ signature, body });
    });

    test("verifyWebhookSignature 验证失败时返回 false", async () => {
        const signature = "invalid_signature";
        const body = "test body";

        mockVerify.mockRejectedValueOnce(new Error("Invalid signature"));
        const result = await service.verifyWebhookSignature(signature, body);

        expect(result).toBe(false);
        expect(mockVerify).toHaveBeenCalledWith({ signature, body });
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

    test("Mock 模式下 publish 返回 mock 结果", async () => {
        // Temporarily remove token
        jest.unstable_mockModule("../../src/config/index.js", () => ({
            config: {
                qstash: null
            }
        }));
        
        jest.clearAllMocks();
        mockPublishJSON.mockResolvedValue({ messageId: "test-id" });
        
        // Re-import to pick up new config
        const module = await import("../../src/services/QStashService.js");
        const mockService = new module.QStashService();
        mockService.isMockMode = true;

        const result = await mockService.publish("topic", {});

        expect(result).toEqual({ messageId: "mock-message-id" });
        expect(mockPublishJSON).not.toHaveBeenCalled();
    });
});