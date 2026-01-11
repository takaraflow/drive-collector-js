import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// 动态导入模块
const { QstashQueue } = await import("../../../src/services/queue/QstashQueue.js");
const { BaseQueue } = await import("../../../src/services/queue/BaseQueue.js");

describe("QstashQueue - Unit Tests", () => {
    let queue;

    beforeEach(() => {
        jest.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        jest.spyOn(global.Math, 'random').mockReturnValue(0.5);
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test("should extend BaseQueue", async () => {
        queue = new QstashQueue();
        expect(queue).toBeInstanceOf(BaseQueue);
        expect(queue.providerName).toBe('QstashQueue');
    });

    test("should have provider name", async () => {
        queue = new QstashQueue();
        expect(queue.providerName).toBe('QstashQueue');
    });

    test("should be initially not connected", async () => {
        queue = new QstashQueue();
        expect(queue.connected).toBe(false);
    });

    test("should be initially not initialized", async () => {
        queue = new QstashQueue();
        expect(queue.isInitialized).toBe(false);
    });

    test("should initialize successfully", async () => {
        queue = new QstashQueue();
        await queue.initialize();

        expect(queue.isInitialized).toBe(true);
        expect(queue.connected).toBe(true);
    });

    test("should extract error code from error message", async () => {
        queue = new QstashQueue();
        await queue.initialize();

        expect(queue._extractErrorCode('Error 500')).toBe(500);
        expect(queue._extractErrorCode('No code here')).toBeNull();
        expect(queue._extractErrorCode('HTTP 404 Not Found')).toBe(404);
        expect(queue._extractErrorCode('Success')).toBeNull();
    });

    test("should extract error code from different formats", async () => {
        queue = new QstashQueue();
        await queue.initialize();

        expect(queue._extractErrorCode('500 Internal Server Error')).toBe(500);
        expect(queue._extractErrorCode('404 Not Found')).toBe(404);
        expect(queue._extractErrorCode('200 OK')).toBe(200);
        expect(queue._extractErrorCode('403 Forbidden')).toBe(403);
        expect(queue._extractErrorCode('401 Unauthorized')).toBe(401);
    });

    test("should extract error code from error message without digits", async () => {
        queue = new QstashQueue();
        await queue.initialize();

        expect(queue._extractErrorCode('Something went wrong')).toBeNull();
    });

    test("should return null for error without message", async () => {
        queue = new QstashQueue();
        await queue.initialize();

        expect(queue._extractErrorCode('')).toBeNull();
    });

    test("should get connection info", async () => {
        queue = new QstashQueue();
        await queue.initialize();

        const info = queue.getConnectionInfo();
        expect(info).toEqual({
            provider: 'QstashQueue',
            connected: true
        });
    });

    test("should handle disconnect", async () => {
        queue = new QstashQueue();
        await queue.initialize();
        
        await queue.disconnect();
        expect(queue.connected).toBe(false);
    });
});
