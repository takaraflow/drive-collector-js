/**
 * CloudQueueBase Tests
 * Tests for CloudQueueBase abstract class functionality
 */

import CloudQueueBase from "../../../src/services/queue/CloudQueueBase.js";

// Mock config and logger
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

// Create a concrete implementation of CloudQueueBase for testing
class TestCloudQueue extends CloudQueueBase {
    constructor(options = {}) {
        super(options);
        this.testClient = { publishJSON: vi.fn() };
    }

    async initialize() {
        this.isInitialized = true;
        return true;
    }

    async publish(topic, data) {
        return { messageId: `msg-${Date.now()}` };
    }

    async batchPublish(messages) {
        return messages.map(msg => ({ messageId: `msg-${msg.data.id}` }));
    }

    async verifyWebhook(signature, body) {
        return signature && signature.length > 0;
    }

    async connect() {
        return true;
    }

    async disconnect() {
        return true;
    }

    getConnectionInfo() {
        return { isMockMode: this.isMockMode, isInitialized: this.isInitialized };
    }

    // Override flush to work with our test implementation
    async flush() {
        if (this.buffer.length === 0) return;
        
        const batch = [...this.buffer];
        this.buffer = [];
        
        // Simulate batch publish
        const results = batch.map(task => ({
            status: 'fulfilled',
            value: { messageId: `msg-${task.data.id}` }
        }));
        
        // Resolve promises
        results.forEach((result, index) => {
            if (batch[index].resolve) {
                batch[index].resolve(result.value);
            }
        });
        
        return results;
    }

    async close() {
        await this.flush();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        return true;
    }
}

describe("CloudQueueBase - Buffer Management", () => {
    let queue;

    beforeEach(() => {
        vi.clearAllMocks();
        queue = new TestCloudQueue({ batchSize: 3, batchTimeout: 1000 });
    });

    test("should add items to buffer", async () => {
        const item = { topic: 'test', data: { id: 1 } };
        queue._addToBuffer(item);
        
        expect(queue.buffer.length).toBe(1);
        expect(queue.buffer[0]).toEqual(item);
    });

    test("should handle empty buffer flush", async () => {
        await queue.flush();
        expect(queue.buffer.length).toBe(0);
    });

    test("should get buffer status", () => {
        const status = queue.getBufferStatus();
        expect(status.size).toBe(0);
        expect(status.batchSize).toBe(3);
        expect(status.batchTimeout).toBe(1000);
    });

    test("should clear buffer", () => {
        queue._addToBuffer({ topic: 'test', data: { id: 1 } });
        queue._addToBuffer({ topic: 'test', data: { id: 2 } });
        
        const cleared = queue.clearBuffer();
        expect(cleared).toBe(2);
        expect(queue.buffer.length).toBe(0);
    });
});

describe("CloudQueueBase - Retry Logic", () => {
    let queue;

    beforeEach(() => {
        vi.clearAllMocks();
        queue = new TestCloudQueue();
    });

    test("should execute successfully on first try", async () => {
        const operation = vi.fn().mockResolvedValue('success');
        const result = await queue._executeWithRetry(operation);
        
        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    test("should retry on failure and eventually succeed", async () => {
        let attempt = 0;
        const operation = vi.fn().mockImplementation(() => {
            attempt++;
            if (attempt === 1) {
                return Promise.reject(new Error('Network error'));
            }
            return Promise.resolve('success');
        });
        
        const result = await queue._executeWithRetry(operation, 3, '[Test]');
        
        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    test("should fail after max retries", async () => {
        let attempt = 0;
        const operation = vi.fn().mockImplementation(() => {
            attempt++;
            return Promise.reject(new Error('Persistent error'));
        });
        
        await expect(queue._executeWithRetry(operation, 3, '[Test]'))
            .rejects.toThrow('Persistent error');
        
        expect(operation).toHaveBeenCalledTimes(3);
    });

    test("should not retry on 4xx errors", async () => {
        const operation = vi.fn().mockRejectedValue(new Error('HTTP 400 Bad Request'));
        
        await expect(queue._executeWithRetry(operation, 3, '[Test]')).rejects.toThrow('HTTP 400 Bad Request');
        expect(operation).toHaveBeenCalledTimes(1);
    });
});

describe("CloudQueueBase - Batch Execution", () => {
    let queue;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        queue = new TestCloudQueue({ maxConcurrent: 2 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test("should execute batch sequentially", async () => {
        const messages = [
            { topic: 'test-1', data: { id: 1 } },
            { topic: 'test-2', data: { id: 2 } }
        ];
        
        const promise = queue._executeBatch(messages, 2, async (msg) => {
            return { messageId: `msg-${msg.data.id}` };
        }, '[Test]');
        
        // Fast-forward through any batch delays
        await vi.advanceTimersByTimeAsync(10);
        
        const results = await promise;
        
        expect(results).toHaveLength(2);
        expect(results[0].value.messageId).toBe('msg-1');
        expect(results[1].value.messageId).toBe('msg-2');
    });

    test("should handle empty batch", async () => {
        const results = await queue._executeBatch([], 2, async (msg) => {
            return { messageId: 'test' };
        }, '[Test]');
        
        expect(results).toEqual([]);
    });

    test("should handle batch with errors", async () => {
        const messages = [
            { topic: 'test-1', data: { id: 1 } },
            { topic: 'test-2', data: { id: 2 } }
        ];
        
        const promise = queue._executeBatch(messages, 2, async (msg) => {
            if (msg.data.id === 1) {
                throw new Error('Processing error');
            }
            return { messageId: `msg-${msg.data.id}` };
        }, '[Test]');
        
        // Fast-forward through retry delays for the failed operation
        await vi.advanceTimersByTimeAsync(125);
        await vi.advanceTimersByTimeAsync(225);
        await vi.advanceTimersByTimeAsync(425);
        
        const results = await promise;
        
        expect(results).toHaveLength(2);
        expect(results[0].status).toBe('rejected');
        expect(results[1].status).toBe('fulfilled');
        expect(results[1].value.messageId).toBe('msg-2');
    });
});

describe("CloudQueueBase - Connection Management", () => {
    let queue;

    beforeEach(() => {
        vi.clearAllMocks();
        queue = new TestCloudQueue();
    });

    test("should handle connect", async () => {
        const result = await queue.connect();
        expect(result).toBe(true);
    });

    test("should handle disconnect", async () => {
        const result = await queue.disconnect();
        expect(result).toBe(true);
    });

    test("should get connection info", async () => {
        await queue.initialize();
        const info = queue.getConnectionInfo();
        
        expect(info).toBeDefined();
        expect(info.isInitialized).toBe(true);
    });
});

describe("CloudQueueBase - Initialization", () => {
    test("should initialize with default options", async () => {
        const queue = new TestCloudQueue();
        await queue.initialize();
        
        expect(queue.isInitialized).toBe(true);
        expect(queue.isMockMode).toBe(false);
    });

    test("should initialize with custom options", async () => {
        const queue = new TestCloudQueue({ 
            batchSize: 10, 
            batchTimeout: 2000
        });
        await queue.initialize();
        
        expect(queue.batchSize).toBe(10);
        expect(queue.batchTimeout).toBe(2000);
    });

    test("should extract error code from error message", () => {
        const queue = new TestCloudQueue();
        
        expect(queue._extractErrorCode('HTTP 404 Not Found')).toBe(404);
        expect(queue._extractErrorCode('Error 500')).toBe(500);
        expect(queue._extractErrorCode('No error code')).toBeNull();
    });
});

describe("CloudQueueBase - Error Handling", () => {
    let queue;

    beforeEach(() => {
        vi.clearAllMocks();
        queue = new TestCloudQueue();
    });

    test("should handle buffer flush with errors", async () => {
        // Mock flush to simulate error
        const originalFlush = queue.flush.bind(queue);
        queue.flush = vi.fn().mockRejectedValue(new Error('Flush failed'));
        
        await expect(queue.close()).rejects.toThrow('Flush failed');
    });

    test("should clear buffer with timer", () => {
        queue.flushTimer = setTimeout(() => {}, 1000);
        queue._addToBuffer({ topic: 'test', data: { id: 1 } });
        
        const cleared = queue.clearBuffer();
        expect(cleared).toBe(1);
        expect(queue.flushTimer).toBeNull();
    });
});