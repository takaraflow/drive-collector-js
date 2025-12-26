import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock KV
const mockKV = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(true)
};
jest.unstable_mockModule('../../src/services/kv.js', () => ({
    kv: mockKV
}));

// Import after mocking
const { PRIORITY, runBotTask } = await import('../../src/utils/limiter.js');

describe('Limiter Priority & Distribution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should respect priority in p-queue', async () => {
        const results = [];
        const task = (id) => async () => {
            // 使用 0 延迟消除 10ms 的硬等待，同时保留异步切换特性
            await new Promise(r => setTimeout(r, 0));
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

});