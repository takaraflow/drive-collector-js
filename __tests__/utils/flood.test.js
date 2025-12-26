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
const { handle429Error } = await import('../../src/utils/limiter.js');

describe('Limiter 429 & FloodWait Handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should retry on FloodWaitError and respect retry-after', async () => {
        // 使用 Fake Timers 消除 1s 的真实等待
        jest.useFakeTimers();
        
        const mockTask = jest.fn()
            .mockRejectedValueOnce({ 
                name: 'FloodWaitError', 
                message: 'A wait of 1 seconds is required', 
                seconds: 1 
            })
            .mockResolvedValueOnce('success');

        const promise = handle429Error(mockTask, 2);
        
        // 推进时间以跳过 sleep
        await jest.advanceTimersByTimeAsync(2000);
        
        const result = await promise;
        expect(result).toBe('success');
        expect(mockTask).toHaveBeenCalledTimes(2);
        
        jest.useRealTimers();
    });

    it('should trigger global cooling for large wait times', async () => {
        const largeWait = 61; // > 60s
        const mockTask1 = jest.fn().mockRejectedValueOnce({ 
            name: 'FloodWaitError', 
            message: `wait ${largeWait} seconds`, 
            seconds: largeWait 
        });
        
        const mockTask2 = jest.fn().mockResolvedValue('success');

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
        await p2;
        expect(mockTask2).toHaveBeenCalled();
        
        jest.useRealTimers();
    });
});