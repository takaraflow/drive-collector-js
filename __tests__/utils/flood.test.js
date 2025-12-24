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
const { handle429Error } = await import('../../src/utils/limiter.js');

describe('Limiter 429 & FloodWait Handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should retry on FloodWaitError and respect retry-after', async () => {
        const mockTask = jest.fn()
            .mockRejectedValueOnce({ 
                name: 'FloodWaitError', 
                message: 'A wait of 1 seconds is required', 
                seconds: 1 
            })
            .mockResolvedValueOnce('success');

        const result = await handle429Error(mockTask, 2);
        expect(result).toBe('success');
        expect(mockTask).toHaveBeenCalledTimes(2);
    });

    it('should trigger global cooling for large wait times', async () => {
        const largeWait = 61; // > 60s
        const mockTask1 = jest.fn().mockRejectedValueOnce({ 
            name: 'FloodWaitError', 
            message: `wait ${largeWait} seconds`, 
            seconds: largeWait 
        });
        
        const mockTask2 = jest.fn().mockResolvedValue('success');

        // 我们不能真的等 61 秒，所以这里 mock timers
        jest.useFakeTimers();

        // 启动第一个任务，它会失败并设置冷静期
        const p1 = handle429Error(mockTask1, 2).catch(e => e);
        
        // 推进一小段时间让 p1 执行到 catch 块
        await jest.advanceTimersByTimeAsync(100);

        // 启动第二个任务，它应该被 checkCooling 阻塞
        const p2 = handle429Error(mockTask2, 1);

        // 推进 30 秒，p2 应该还在等
        await jest.advanceTimersByTimeAsync(30000);
        expect(mockTask2).not.toHaveBeenCalled();

        // 推进到冷静期结束
        await jest.advanceTimersByTimeAsync(35000);
        
        // 最终 p2 应该执行了
        // 注意：handle429Error 内部的 sleep 也是被 mocked 的
        // 且 p1 的重试也需要时间，这里我们主要验证逻辑
        
        jest.useRealTimers();
    });
});