import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

jest.mock("../../src/config/index.js", () => ({
    getConfig: jest.fn(() => ({
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    })),
    initConfig: jest.fn(async () => ({
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    })),
    config: {
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    }
}));

jest.mock("../../src/services/logger.js", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    },
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

import { QueueService } from "../../src/services/QueueService.js";

describe("QueueService - Unit Tests", () => {
    let service;
    let mockProvider;

    beforeEach(() => {
        jest.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        jest.spyOn(global.Math, 'random').mockReturnValue(0.5);
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test("should use QstashQueue as default provider", async () => {
        service = new QueueService();
        await service.initialize();

        expect(service.isInitialized).toBe(true);
        expect(service.queueProvider.providerName).toBe('QstashQueue');
    });

    test("should accept custom queue provider", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'custom-id' }),
            batchPublish: jest.fn().mockResolvedValue([{ messageId: 'custom-id' }]),
            verifyWebhook: jest.fn().mockResolvedValue(true),
            getCircuitBreakerStatus: jest.fn().mockReturnValue({ state: 'CLOSED' }),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        expect(service.queueProvider).toBe(mockProvider);
        expect(mockProvider.initialize).toHaveBeenCalled();
    });

    test("should add metadata to published messages", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: jest.fn().mockResolvedValue([]),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const originalMessage = { data: "test", taskId: "task-1" };
        await service.publish("test-topic", originalMessage);

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/tasks/test-topic",
            expect.objectContaining({
                data: "test",
                taskId: "task-1",
                _meta: expect.objectContaining({
                    triggerSource: 'direct-qstash',
                    timestamp: expect.any(Number),
                    instanceId: expect.any(String),
                    caller: expect.any(String)
                })
            }),
            {}
        );
    });

    test("should preserve original message properties", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: jest.fn().mockResolvedValue([]),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.publish("test-topic", { taskId: "123", status: "pending", priority: 1 });

        const callArgs = mockProvider.publish.mock.calls[0][1];
        expect(callArgs.taskId).toBe("123");
        expect(callArgs.status).toBe("pending");
        expect(callArgs.priority).toBe(1);
    });

    test("should call enqueueDownloadTask with correct topic and data", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: jest.fn().mockResolvedValue([]),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.enqueueDownloadTask("task-123", { url: "https://example.com/file.mp4" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/tasks/download",
            expect.objectContaining({
                taskId: "task-123",
                type: "download",
                url: "https://example.com/file.mp4"
            }),
            {}
        );
    });

    test("should call enqueueUploadTask with correct topic and data", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: jest.fn().mockResolvedValue([]),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.enqueueUploadTask("task-456", { fileId: "file-789" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/tasks/upload",
            expect.objectContaining({
                taskId: "task-456",
                type: "upload",
                fileId: "file-789"
            }),
            {}
        );
    });

    test("should call broadcastSystemEvent with correct topic and data", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: jest.fn().mockResolvedValue([]),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.broadcastSystemEvent("task-completed", { taskId: "task-789" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/tasks/system-events",
            expect.objectContaining({
                event: "task-completed",
                taskId: "task-789"
            }),
            {}
        );
    });

    test("should batch publish with enhanced messages", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: jest.fn().mockResolvedValue([{ messageId: 'msg-123' }]),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const messages = [
            { topic: "download", message: { taskId: "1" } },
            { topic: "upload", message: { taskId: "2" } }
        ];

        await service.batchPublish(messages);

        expect(mockProvider.batchPublish).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    topic: "https://example.com/api/tasks/download",
                    message: expect.objectContaining({
                        taskId: "1",
                        _meta: expect.any(Object)
                    })
                }),
                expect.objectContaining({
                    topic: "https://example.com/api/tasks/upload",
                    message: expect.objectContaining({
                        taskId: "2",
                        _meta: expect.any(Object)
                    })
                })
            ])
        );
    });

    test("should verify webhook signature through provider", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn(),
            batchPublish: jest.fn(),
            verifyWebhook: jest.fn().mockResolvedValue(true),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const result = await service.verifyWebhookSignature("sig123", "body123");

        expect(mockProvider.verifyWebhook).toHaveBeenCalledWith("sig123", "body123");
        expect(result).toBe(true);
    });

    test("should get circuit breaker status from provider", async () => {
        const mockStatus = { state: 'OPEN', failureCount: 5 };
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn(),
            batchPublish: jest.fn(),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn().mockReturnValue(mockStatus),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const status = service.getCircuitBreakerStatus();

        expect(mockProvider.getCircuitBreakerStatus).toHaveBeenCalled();
        expect(status).toEqual(mockStatus);
    });

    test("should reset circuit breaker through provider", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn(),
            batchPublish: jest.fn(),
            verifyWebhook: jest.fn(),
            getCircuitBreakerStatus: jest.fn(),
            resetCircuitBreaker: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        service.resetCircuitBreaker();

        expect(mockProvider.resetCircuitBreaker).toHaveBeenCalled();
    });

    test("should handle provider without circuit breaker methods", async () => {
        mockProvider = {
            initialize: jest.fn(),
            publish: jest.fn(),
            batchPublish: jest.fn(),
            verifyWebhook: jest.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const status = service.getCircuitBreakerStatus();
        expect(status).toBeNull();

        service.resetCircuitBreaker();
    });

    test("should have correct topics", () => {
        service = new QueueService();
        expect(service.topics).toEqual({
            downloadTasks: "download",
            uploadTasks: "upload",
            systemEvents: "system-events"
        });
    });
});
