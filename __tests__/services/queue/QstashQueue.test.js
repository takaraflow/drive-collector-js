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

// Mock CircuitBreaker
vi.mock("../../../src/services/CircuitBreaker.js", () => ({
    CircuitBreakerManager: {
        get: vi.fn(() => ({
            execute: vi.fn(async (fn, fallback) => {
                try {
                    return await fn();
                } catch (error) {
                    return fallback ? fallback() : undefined;
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
        
        queue = new QstashQueue();
        await queue.initialize();
    });

    test("should publish directly when batch size is 1", async () => {
        mockPublishJSON.mockResolvedValue({ messageId: 'msg-1' });

        const result = await queue._publish('test-topic', { data: 'test' });
        
        expect(result).toEqual({ messageId: 'msg-1' });
        expect(mockPublishJSON).toHaveBeenCalledWith({
            url: 'test-topic',
            body: { data: 'test' }
        });
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
    });

    test("should return mock message in mock mode", async () => {
        const { getConfig } = await import("../../../src/config/index.js");
        getConfig.mockReturnValueOnce({
            qstash: { token: '' }
        });

        const mockQueue = new QstashQueue();
        await mockQueue.initialize();

        const result = await mockQueue._publish('test-topic', { data: 'test' });
        
        // In mock mode with batch size > 1, it goes to buffer and returns fallback
        expect(result).toBeDefined();
        expect(result.messageId).toBe("fallback-message-id");
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