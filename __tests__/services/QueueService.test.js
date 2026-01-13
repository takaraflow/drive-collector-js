vi.mock("../../src/config/index.js", () => ({
    getConfig: vi.fn(() => ({
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    })),
    initConfig: vi.fn(async () => ({
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

vi.mock("../../src/services/logger/index.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    },
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

import { QueueService } from "../../src/services/QueueService.js";

describe("QueueService - Unit Tests", () => {
    let service;
    let mockProvider;

    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should use QstashQueue as default provider", async () => {
        service = new QueueService();
        await service.initialize();

        expect(service.isInitialized).toBe(true);
        expect(service.queueProvider.providerName).toBe('QstashQueue');
    });

    test("should accept custom queue provider", async () => {
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'custom-id' }),
            batchPublish: vi.fn().mockResolvedValue([{ messageId: 'custom-id' }]),
            verifyWebhook: vi.fn().mockResolvedValue(true),
            getCircuitBreakerStatus: vi.fn().mockReturnValue({ state: 'CLOSED' }),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        expect(service.queueProvider).toBe(mockProvider);
        expect(mockProvider.initialize).toHaveBeenCalled();
    });

    test("should add metadata to published messages", async () => {
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const originalMessage = { data: "test", taskId: "task-1" };
        await service.publish("test-topic", originalMessage);

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/v2/tasks/test-topic",
            expect.objectContaining({
                data: "test",
                taskId: "task-1",
                _meta: expect.objectContaining({
                    triggerSource: 'qstash-v2',
                    timestamp: expect.any(Number),
                    instanceId: expect.any(String)
                })
            }),
            {}
        );
    });

    test("should add caller context in production mode", async () => {
        process.env.CALLER_TRACKING_MODE = 'production';
        process.env.INSTANCE_ID = 'test-instance-123';

        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const originalMessage = { data: "test" };
        await service.publish("test-topic", originalMessage);

        const callArgs = mockProvider.publish.mock.calls[0][1];
        expect(callArgs._meta.callerContext).toBeDefined();
        expect(Array.isArray(callArgs._meta.callerContext)).toBe(true);
        
        delete process.env.CALLER_TRACKING_MODE;
        delete process.env.INSTANCE_ID;
    });

    test("should use default template when pathTemplate not configured", async () => {
        // The config is already mocked at module level, so we can use it directly
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.publish("test-topic", { data: "test" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/v2/tasks/test-topic",
            expect.any(Object),
            {}
        );
    });

    test("should preserve original message properties", async () => {
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
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
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.enqueueDownloadTask("task-123", { url: "https://example.com/file.mp4" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/v2/tasks/download",
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
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.enqueueUploadTask("task-456", { fileId: "file-789" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/v2/tasks/upload",
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
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        await service.broadcastSystemEvent("task-completed", { taskId: "task-789" });

        expect(mockProvider.publish).toHaveBeenCalledWith(
            "https://example.com/api/v2/tasks/system-events",
            expect.objectContaining({
                event: "task-completed",
                taskId: "task-789"
            }),
            {}
        );
    });

    test("should batch publish with enhanced messages", async () => {
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
            batchPublish: vi.fn().mockResolvedValue([{ messageId: 'msg-123' }]),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
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
                    topic: "https://example.com/api/v2/tasks/download",
                    message: expect.objectContaining({
                        taskId: "1",
                        _meta: expect.any(Object)
                    })
                }),
                expect.objectContaining({
                    topic: "https://example.com/api/v2/tasks/upload",
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
            initialize: vi.fn(),
            publish: vi.fn(),
            batchPublish: vi.fn(),
            verifyWebhook: vi.fn().mockResolvedValue(true),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
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
            initialize: vi.fn(),
            publish: vi.fn(),
            batchPublish: vi.fn(),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn().mockReturnValue(mockStatus),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        const status = service.getCircuitBreakerStatus();

        expect(mockProvider.getCircuitBreakerStatus).toHaveBeenCalled();
        expect(status).toEqual(mockStatus);
    });

    test("should reset circuit breaker through provider", async () => {
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn(),
            batchPublish: vi.fn(),
            verifyWebhook: vi.fn(),
            getCircuitBreakerStatus: vi.fn(),
            resetCircuitBreaker: vi.fn()
        };

        service = new QueueService(mockProvider);
        await service.initialize();

        service.resetCircuitBreaker();

        expect(mockProvider.resetCircuitBreaker).toHaveBeenCalled();
    });

    test("should handle provider without circuit breaker methods", async () => {
        mockProvider = {
            initialize: vi.fn(),
            publish: vi.fn(),
            batchPublish: vi.fn(),
            verifyWebhook: vi.fn()
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