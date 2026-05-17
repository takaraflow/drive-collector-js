/**
 * QstashQueue Tests
 * Tests for QStash queue implementation with CloudQueueBase
 */

// Mock QStash client using factory functions
const mockPublishJSON = vi.fn();
const mockVerify = vi.fn();

vi.mock("@upstash/qstash", () => ({
    Client: function(options) {
        return {
            token: options.token,
            publishJSON: mockPublishJSON,
            batch: function() {
                return {
                    publishJSON: mockPublishJSON
                };
            }
        };
    },
    Receiver: function(options) {
        return {
            currentSigningKey: options.currentSigningKey,
            nextSigningKey: options.nextSigningKey,
            verify: mockVerify
        };
    }
}));

// Mock async-mutex - fix the constructor issue
vi.mock("async-mutex", () => {
    return {
        Mutex: class MockMutex {
            constructor() {
                this.acquire = vi.fn().mockResolvedValue(() => {});
                this.release = vi.fn();
                this.isLocked = vi.fn().mockReturnValue(false);
                this.runExclusive = vi.fn(async (fn) => {
                    return await fn();
                });
                this.waitForUnlock = vi.fn().mockResolvedValue(undefined);
                this.cancel = vi.fn();
            }
        }
    };
});

vi.mock("../../../src/config/index.js", () => ({
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

vi.mock("../../../src/services/logger/index.js", () => ({
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

const mockCacheSet = vi.fn().mockResolvedValue(true);
const mockCacheGet = vi.fn();
const mockCacheDelete = vi.fn().mockResolvedValue(true);
const mockCacheListKeys = vi.fn();

vi.mock("../../../src/services/CacheService.js", () => ({
    cache: {
        set: mockCacheSet,
        get: mockCacheGet,
        delete: mockCacheDelete,
        listKeys: mockCacheListKeys
    }
}));

// Mock CircuitBreaker
vi.mock("../../../src/services/CircuitBreaker.js", () => ({
    CircuitBreakerManager: {
        get: vi.fn(() => ({
            execute: vi.fn(async (fn, fallback) => {
                try {
                    return await fn();
                } catch (error) {
                    if (fallback) return fallback();
                    throw error;
                }
            }),
            getStatus: vi.fn(() => ({ state: 'CLOSED' })),
            reset: vi.fn()
        }))
    }
}));

import { QstashQueue } from "../../../src/services/queue/QstashQueue.js";

describe("QstashQueue - Initialize", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        mockVerify.mockReset();
    });

    test("should initialize successfully with valid config", async () => {
        const queue = new QstashQueue();
        await queue.initialize();
        
        expect(queue).toBeDefined();
        expect(queue.isMockMode).toBe(false);
        expect(queue.client).toBeDefined();
        expect(queue.client.token).toBe('test-token');
    });

    test("should use mock mode when token is missing", async () => {
        const { getConfig } = await import("../../../src/config/index.js");
        getConfig.mockReturnValueOnce({
            qstash: { token: '' }
        });

        const queue = new QstashQueue();
        await queue.initialize();
        
        expect(queue.isMockMode).toBe(true);
        expect(queue.client).toBeNull();
    });
});

describe("QstashQueue - publish", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        mockCacheSet.mockClear();
        mockCacheGet.mockReset();
        mockCacheDelete.mockClear();
        mockCacheListKeys.mockReset();
        
        queue = new QstashQueue();
        await queue.initialize();
    });

    test("should publish directly when batch size is 1", async () => {
        // Override batch size to 1 for direct publishing
        queue.batchSize = 1;
        mockPublishJSON.mockResolvedValue({ messageId: 'msg-1' });

        const result = await queue._publish('test-topic', { data: 'test' });
        
        expect(result).toEqual({ messageId: 'msg-1' });
        expect(mockPublishJSON).toHaveBeenCalledWith({
            url: 'test-topic',
            body: { data: 'test' }
        });
    });

    test("should use explicit idempotency key without forwarding it to QStash", async () => {
        queue.batchSize = 1;
        mockPublishJSON.mockResolvedValue({ messageId: 'msg-1' });

        const first = await queue._publish('test-topic', {
            taskId: 'task-1',
            type: 'download',
            _meta: { timestamp: 1000 }
        }, { idempotencyKey: 'download:download:task-1:initial' });
        const second = await queue._publish('test-topic', {
            taskId: 'task-1',
            type: 'download',
            _meta: { timestamp: 2000 }
        }, { idempotencyKey: 'download:download:task-1:initial' });

        expect(first).toEqual({ messageId: 'msg-1' });
        expect(second).toEqual({ messageId: 'download:download:task-1:initial', duplicate: true });
        expect(mockPublishJSON).toHaveBeenCalledTimes(1);
        expect(mockPublishJSON.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
    });

    test("should publish again when retry uses a new queue attempt", async () => {
        queue.batchSize = 1;
        mockPublishJSON
            .mockResolvedValueOnce({ messageId: 'msg-1' })
            .mockResolvedValueOnce({ messageId: 'msg-2' });

        const first = await queue._publish('test-topic', {
            taskId: 'task-1',
            type: 'download',
            _meta: { queueAttempt: 'initial' }
        }, { idempotencyKey: 'download:download:task-1:initial' });
        const second = await queue._publish('test-topic', {
            taskId: 'task-1',
            type: 'download',
            _meta: { queueAttempt: 'queued:1700000000000' }
        }, { idempotencyKey: 'download:download:task-1:queued:1700000000000' });

        expect(first).toEqual({ messageId: 'msg-1' });
        expect(second).toEqual({ messageId: 'msg-2' });
        expect(mockPublishJSON).toHaveBeenCalledTimes(2);
    });

    test("should add to buffer when batching is enabled", async () => {
        const batchingQueue = new QstashQueue({ batchSize: 5, batchTimeout: 1000 });
        await batchingQueue.initialize();

        // When batching, _publish returns a Promise that resolves when buffer is flushed
        const publishPromise = batchingQueue._publish('test-topic', { data: 'test' });
        
        // Check that item was added to buffer
        expect(batchingQueue.buffer.length).toBe(1);
        expect(batchingQueue.buffer[0].topic).toBe('test-topic');
        expect(batchingQueue.buffer[0].message).toEqual({ data: 'test' });
        
        // Resolve the promise by clearing buffer
        batchingQueue.clearBuffer();
        await expect(publishPromise).rejects.toThrow('Buffer cleared');
    });

    test("should reject buffered publish when publish fails", async () => {
        vi.useFakeTimers();

        const batchingQueue = new QstashQueue({ batchSize: 5, batchTimeout: 10 });
        await batchingQueue.initialize();

        mockPublishJSON.mockRejectedValue(new Error('publish failed'));

        const publishPromise = batchingQueue._publish('test-topic', { data: 'test' });
        const assertion = expect(publishPromise).rejects.toThrow('publish failed');

        await vi.advanceTimersByTimeAsync(20);
        await vi.runAllTimersAsync();
        await assertion;
        expect(mockCacheSet).toHaveBeenCalledWith(
            expect.stringMatching(/^queue:dlq:dlq_/),
            expect.objectContaining({
                reason: 'publish_failed',
                error: 'publish failed',
                message: expect.objectContaining({
                    topic: 'test-topic',
                    message: { data: 'test' }
                })
            }),
            604800,
            expect.objectContaining({ skipL1: true, skipTtlRandomization: true })
        );

        vi.useRealTimers();
    });

    test("should reject direct publish failures after persisting DLQ", async () => {
        queue.batchSize = 1;
        mockPublishJSON.mockRejectedValue(new Error('publish failed'));

        await expect(queue._publish('test-topic', { data: 'test' }, {
            forceDirect: true,
            requireDurableAck: true
        })).rejects.toThrow('publish failed');

        expect(mockPublishJSON).toHaveBeenCalledWith({
            url: 'test-topic',
            body: { data: 'test' }
        });
        expect(mockCacheSet).toHaveBeenCalledWith(
            expect.stringMatching(/^queue:dlq:dlq_/),
            expect.objectContaining({
                reason: 'publish_failed',
                error: 'publish failed'
            }),
            604800,
            expect.objectContaining({ skipL1: true, skipTtlRandomization: true })
        );
    });

    test("should read persistent dead letters when requested", async () => {
        const persisted = [
            { id: 'dlq_late', timestamp: 2000 },
            { id: 'dlq_early', timestamp: 1000 }
        ];
        mockCacheListKeys.mockResolvedValue(['queue:dlq:dlq_late', 'queue:dlq:dlq_early']);
        mockCacheGet
            .mockResolvedValueOnce(persisted[0])
            .mockResolvedValueOnce(persisted[1]);

        await expect(queue.getDeadLetterQueue({ includePersistent: true })).resolves.toEqual([
            persisted[1],
            persisted[0]
        ]);
    });

    test("should settle pending publishes when flush fails after dequeue", async () => {
        const batchingQueue = new QstashQueue({ batchSize: 5, batchTimeout: 1000 });
        await batchingQueue.initialize();

        const buffered = batchingQueue._publish('test-topic', { data: 'test' });
        expect(batchingQueue.buffer.length).toBe(1);

        batchingQueue.bufferMutex.runExclusive.mockImplementationOnce(async () => {
            const batch = [...batchingQueue.buffer];
            batchingQueue.buffer = [];
            batch.forEach(task => task.reject(new Error('flush failed after dequeue')));
            throw new Error('flush failed after dequeue');
        });

        const flushPromise = batchingQueue.flush().catch(error => error);
        await expect(buffered).rejects.toThrow('flush failed after dequeue');
        await expect(flushPromise).resolves.toBeInstanceOf(Error);
    });

    test("should return mock message in mock mode", async () => {
        const { getConfig } = await import("../../../src/config/index.js");
        getConfig.mockReturnValueOnce({
            qstash: { token: '' }
        });

        const mockQueue = new QstashQueue({ batchSize: 1 }); // Force direct mode
        await mockQueue.initialize();

        const result = await mockQueue._publish('test-topic', { data: 'test' });
        
        // In mock mode with batch size 1, it should return a message ID
        expect(result).toBeDefined();
        expect(result.messageId).toBeDefined();
        expect(result.messageId).toMatch(/^msg_/);
    });
});

describe("QstashQueue - flush", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        
        queue = new QstashQueue({ batchSize: 3, batchTimeout: 1000 });
        await queue.initialize();
    });

    test("should do nothing when buffer is empty", async () => {
        await queue.flush();
        expect(mockPublishJSON).not.toHaveBeenCalled();
    });

    test("should flush buffer", async () => {
        // Add items to buffer
        queue.buffer.push({ topic: 'test-1', message: { id: 1 } });
        queue.buffer.push({ topic: 'test-2', message: { id: 2 } });

        // Mock the batch execution
        mockPublishJSON.mockResolvedValue({ messageId: 'batch-msg' });

        await queue.flush();

        // Buffer should be cleared
        expect(queue.buffer.length).toBe(0);
    });

    test("should prevent clearing buffer while flush is in progress", async () => {
        queue.buffer.push({ topic: 'test-1', message: { id: 1 } });
        queue._flushInProgress = Promise.resolve();

        expect(() => queue.clearBuffer()).toThrow('Cannot clear buffer while flush is in progress');

        queue._flushInProgress = null;
    });
});

describe("QstashQueue - batchPublish", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        
        queue = new QstashQueue();
        await queue.initialize();
    });

    test("should batch publish messages", async () => {
        mockPublishJSON.mockResolvedValue({ messageId: 'batch-msg' });

        const messages = [
            { topic: 'test-1', message: { id: 1 } },
            { topic: 'test-2', message: { id: 2 } }
        ];

        const results = await queue._batchPublish(messages);
        
        expect(results).toHaveLength(2);
        expect(mockPublishJSON).toHaveBeenCalledTimes(2);
    });

    test("should return mock messages in mock mode", async () => {
        const { getConfig } = await import("../../../src/config/index.js");
        getConfig.mockReturnValueOnce({
            qstash: { token: '' }
        });

        const mockQueue = new QstashQueue();
        await mockQueue.initialize();

        const messages = [
            { topic: 'test-1', message: { id: 1 } },
            { topic: 'test-2', message: { id: 2 } }
        ];

        const results = await mockQueue._batchPublish(messages);
        
        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({ messageId: "mock-message-id" });
    });
});

describe("QstashQueue - verifyWebhook", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockVerify.mockReset();
        
        queue = new QstashQueue();
        await queue.initialize();
    });

    test("should verify webhook signature", async () => {
        mockVerify.mockResolvedValueOnce(true);

        const result = await queue._verifyWebhook('valid-signature', 'body');
        
        expect(result).toBe(true);
        expect(mockVerify).toHaveBeenCalledWith({ signature: 'valid-signature', body: 'body' });
    });

    test("should return false when signature is missing", async () => {
        const result = await queue._verifyWebhook('', 'body');
        
        expect(result).toBe(false);
    });

    test("should return true in mock mode", async () => {
        const { getConfig } = await import("../../../src/config/index.js");
        getConfig.mockReturnValueOnce({
            qstash: { token: '' }
        });

        const mockQueue = new QstashQueue();
        await mockQueue.initialize();

        const result = await mockQueue._verifyWebhook('any-signature', 'body');
        
        expect(result).toBe(true);
    });
});

describe("QstashQueue - close", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        
        queue = new QstashQueue({ batchSize: 3, batchTimeout: 1000 });
        await queue.initialize();
    });

    test("should flush and clear timer", async () => {
        queue.buffer.push({ topic: 'test-1', message: { id: 1 } });
        queue.flushTimer = setTimeout(() => {}, 1000);

        mockPublishJSON.mockResolvedValue({ messageId: 'batch-1' });

        await queue.close();

        expect(queue.buffer.length).toBe(0);
        expect(queue.flushTimer).toBeNull();
    });
});

describe("QstashQueue - Connection Management", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        
        queue = new QstashQueue();
        await queue.initialize();
    });

    test("should handle connect", async () => {
        await queue.connect();
        expect(queue.connected).toBe(true);
    });

    test("should handle disconnect", async () => {
        await queue.connect();
        await queue.disconnect();
        expect(queue.connected).toBe(false);
    });

    test("should get connection info", async () => {
        await queue.connect();
        const info = queue.getConnectionInfo();
        expect(info).toBeDefined();
        expect(info.provider).toBe('QstashQueue');
        expect(info.connected).toBe(true);
    });
});

describe("QstashQueue - Circuit Breaker", () => {
    let queue;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockPublishJSON.mockReset();
        
        queue = new QstashQueue();
        await queue.initialize();
    });

    test("should get circuit breaker status", () => {
        const status = queue.getCircuitBreakerStatus();
        expect(status).toBeDefined();
        expect(status.state).toBe('CLOSED');
    });

    test("should reset circuit breaker", () => {
        queue.resetCircuitBreaker();
        // Should not throw
        expect(true).toBe(true);
    });
});
