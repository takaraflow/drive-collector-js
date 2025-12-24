import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock redis
const mockRedis = {
    enabled: false,
    slidingWindowLimit: jest.fn()
};
jest.unstable_mockModule('../../src/services/redis.js', () => ({
    redis: mockRedis
}));

// Import after mocking
const { PRIORITY, runBotTask } = await import('../../src/utils/limiter.js');
const { redis } = await import('../../src/services/redis.js');

describe('Limiter Priority & Distribution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        redis.enabled = false;
    });

    it('should respect priority in p-queue', async () => {
        const results = [];
        const task = (id) => async () => {
            await new Promise(r => setTimeout(r, 10));
            results.push(id);
        };

        // 模拟一个用户 ID
        const userId = "test_user";

        // 提交一个 NORMAL 任务
        const p1 = runBotTask(task(1), userId, { priority: PRIORITY.NORMAL });
        // 提交一个 UI 任务 (更高优先级)
        const p2 = runBotTask(task(2), userId, { priority: PRIORITY.UI });
        // 提交一个 BACKGROUND 任务 (最低优先级)
        const p3 = runBotTask(task(3), userId, { priority: PRIORITY.BACKGROUND });

        await Promise.all([p1, p2, p3]);

        expect(results).toContain(2);
        expect(results).toContain(1);
        expect(results).toContain(3);
        expect(results.length).toBe(3);
    });

    it('should trigger distributed limit when redis is enabled', async () => {
        redis.enabled = true;
        redis.slidingWindowLimit.mockResolvedValue({ allowed: true, remaining: 10 });

        const task = async () => "ok";
        const result = await runBotTask(task, "user1");

        expect(result).toBe("ok");
        expect(redis.slidingWindowLimit).toHaveBeenCalledWith(
            expect.stringContaining("limiter:bot:global"),
            expect.any(Number),
            expect.any(Number)
        );
    });

    it('should retry when distributed limit is reached', async () => {
        redis.enabled = true;
        // 第一次拒绝，第二次允许
        redis.slidingWindowLimit
            .mockResolvedValueOnce({ allowed: false, remaining: 0 })
            .mockResolvedValueOnce({ allowed: true, remaining: 29 });

        const task = async () => "ok";
        const result = await runBotTask(task, "user1");

        expect(result).toBe("ok");
        expect(redis.slidingWindowLimit).toHaveBeenCalledTimes(2);
    });
});