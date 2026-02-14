import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';

describe("Telegram Client Lock and Timeout Protection (Simulated)", () => {
    let mockClient;
    let mockCoordinator;
    
    beforeEach(async () => {
        vi.useFakeTimers();
        
        mockClient = {
            disconnect: vi.fn(() => {
                // Use fake timer instead of real setTimeout
                return new Promise(resolve => {
                    // This will be resolved by advanceTimersByTimeAsync
                    const timer = setTimeout(resolve, 2000);
                    return timer;
                });
            }),
            start: vi.fn().mockResolvedValue(undefined),
            connected: true
        };

        mockCoordinator = {
            acquireLock: vi.fn().mockResolvedValue(true),
            hasLock: vi.fn().mockResolvedValue(false),
            instanceId: "inst_1"
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * 模拟 index.js 中的 startTelegramClient 逻辑（适配新版本）
     */
    async function simulateStartTelegramClient(context) {
        // 检查是否已经持有锁（用于区分首次获取和续租）
        const alreadyHasLock = await mockCoordinator.hasLock("telegram_client");
        
        // 尝试获取 Telegram 客户端专属锁 (增加 TTL 到 90s，减少因延迟导致的丢失)
        // 增加重试次数到 5 次，以应对发版时新旧实例交替的短暂冲突
        const hasLock = await mockCoordinator.acquireLock("telegram_client", 90, { maxAttempts: 5 });
        
        if (!hasLock) {
            if (context.isClientActive) {
                // 只有在真正失去锁时才记录警告日志
                try {
                    // 核心逻辑：Promise.race 保护
                    await Promise.race([
                        mockClient.disconnect(),
                        new Promise((_, reject) => {
                            const timer = setTimeout(() => reject(new Error("Disconnect Timeout")), 5000);
                            return timer;
                        })
                     ]);
                } catch (e) {
                    // ignore
                }
                context.isClientActive = false;
            } else {
                // 静默续租失败，但客户端未激活，只需调试日志
            }
            context.hasLock = false;
            return false;
        }

        // 成功获取锁
        
        if (context.isClientActive) {
            // 续租成功，只在调试模式下记录
            if (alreadyHasLock) {
            }
            return true;
        }
        
        // 首次获取锁，记录信息日志
        if (!alreadyHasLock) {
        } else {
            console.log("🔒 续租成功，客户端已激活");
        }
        
        await mockClient.start();
        context.isClientActive = true;
        return true;
    }

    test("should disconnect successfully when lock is lost", async () => {
        const context = { isClientActive: true };
        mockCoordinator.acquireLock.mockResolvedValue(false); // 模拟失去锁

        const promise = simulateStartTelegramClient(context);
        
        // 推进时间以完成 disconnect (2s)
        await vi.advanceTimersByTimeAsync(2000);
        
        const result = await promise;
        expect(result).toBe(false);
        expect(context.isClientActive).toBe(false);
        expect(mockClient.disconnect).toHaveBeenCalled();
    });

    test("should force timeout if disconnect takes too long", async () => {
        const context = { isClientActive: true };
        mockCoordinator.acquireLock.mockResolvedValue(false);
        
        // 模拟一个永久卡死的 disconnect
        mockClient.disconnect.mockReturnValue(new Promise(() => {})); 

        const promise = simulateStartTelegramClient(context);

        // 推进时间超过 5s 保护阈值
        await vi.advanceTimersByTimeAsync(5100);

        await promise;

        expect(context.isClientActive).toBe(false);
    });

    test("should use 90s TTL for lock and 5 max attempts", async () => {
        const context = { isClientActive: false };
        await simulateStartTelegramClient(context);
        expect(mockCoordinator.acquireLock).toHaveBeenCalledWith("telegram_client", 90, expect.objectContaining({ maxAttempts: 5 }));
    });

    test("should release lock during graceful shutdown (index.js logic)", async () => {
        const mockReleaseLock = vi.fn().mockResolvedValue(undefined);
        const coordinator = {
            releaseLock: mockReleaseLock
        };

        // 模拟 index.js 中的 gracefulShutdown 逻辑片段
        const gracefulShutdownFragment = async () => {
            try {
                await coordinator.releaseLock("telegram_client");
            } catch (e) {
                // ignore
            }
        };

        await gracefulShutdownFragment();
        expect(mockReleaseLock).toHaveBeenCalledWith("telegram_client");
    });
});