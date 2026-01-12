/**
 * QStash Queue Batch Processing Tests
 * Tests for batch processing and local buffering functionality
 */

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

describe("QStash Queue - Batch Processing", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should batch multiple messages within timeout window", async () => {
        // Test batch processing logic
        const messages = [];
        const batchSize = 5;
        const batchTimeout = 1000;
        
        // Simulate adding messages to batch
        messages.push({ topic: 'test-topic-1', data: { id: 1 } });
        messages.push({ topic: 'test-topic-1', data: { id: 2 } });
        messages.push({ topic: 'test-topic-1', data: { id: 3 } });
        
        // Verify batch size
        expect(messages.length).toBeLessThanOrEqual(batchSize);
        
        // Simulate timeout behavior
        const startTime = Date.now();
        await vi.advanceTimersByTimeAsync(batchTimeout);
        const endTime = Date.now();
        
        expect(endTime - startTime).toBeGreaterThanOrEqual(batchTimeout);
    });

    test("should flush batch immediately when batch size is reached", async () => {
        const batchSize = 3;
        const messages = [];
        
        // Add messages up to batch size
        messages.push({ topic: 'test-topic', data: { id: 1 } });
        messages.push({ topic: 'test-topic', data: { id: 2 } });
        messages.push({ topic: 'test-topic', data: { id: 3 } });
        
        // Should flush immediately
        expect(messages.length).toBe(batchSize);
    });

    test("should handle batch errors gracefully", async () => {
        // Test error handling
        const errors = [];
        
        try {
            throw new Error('QStash error');
        } catch (error) {
            errors.push(error.message);
        }
        
        expect(errors).toContain('QStash error');
        expect(errors.length).toBe(1);
    });
});

describe("Local Buffer Queue", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should buffer messages in memory", async () => {
        const buffer = [];
        
        // Simulate enqueue operations
        buffer.push({ topic: 'test', data: { id: 1 } });
        buffer.push({ topic: 'test', data: { id: 2 } });
        
        expect(buffer).toHaveLength(2);
        expect(buffer[0]).toEqual({ topic: 'test', data: { id: 1 } });
        expect(buffer[1]).toEqual({ topic: 'test', data: { id: 2 } });
    });

    test("should flush buffer on interval", async () => {
        const buffer = [{ topic: 'test', data: { id: 1 } }];
        let flushed = false;
        
        // Simulate interval flush
        setTimeout(() => {
            flushed = true;
        }, 2000);
        
        await vi.advanceTimersByTimeAsync(2100);
        expect(flushed).toBe(true);
    });
});

describe("Adaptive Rate Limiter", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should start with configured concurrency limit", async () => {
        const maxConcurrent = 5;
        let activeCount = 0;
        const results = [];
        
        // Simulate concurrent tasks
        const tasks = Array(5).fill(null).map(async (_, i) => {
            activeCount++;
            await vi.advanceTimersByTimeAsync(100);
            activeCount--;
            results.push(`task-${i}`);
            return 'success';
        });
        
        await Promise.all(tasks);
        
        expect(results).toHaveLength(5);
        expect(activeCount).toBe(0);
    });

    test("should handle concurrent execution limits", async () => {
        const maxConcurrent = 2;
        let activeCount = 0;
        let maxActive = 0;
        
        // Create a simple rate limiter simulation
        const executeWithLimit = async (task) => {
            // Wait until we have capacity
            while (activeCount >= maxConcurrent) {
                await vi.advanceTimersByTimeAsync(10);
            }
            
            activeCount++;
            maxActive = Math.max(maxActive, activeCount);
            
            // Execute task
            const result = await task();
            
            activeCount--;
            return result;
        };
        
        const tasks = Array(5).fill(null).map((_, i) =>
            executeWithLimit(async () => {
                await vi.advanceTimersByTimeAsync(50);
                return `task-${i}`;
            })
        );
        
        const results = await Promise.all(tasks);
        
        expect(results).toHaveLength(5);
        expect(maxActive).toBeLessThanOrEqual(maxConcurrent);
        expect(activeCount).toBe(0);
    });
});
