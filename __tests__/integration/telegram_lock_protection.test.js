import { jest, describe, test, expect, beforeEach } from "@jest/globals";

describe("Telegram Client Lock and Timeout Protection (Simulated)", () => {
    let mockClient;
    let mockCoordinator;
    
    beforeEach(async () => {
        jest.useFakeTimers();
        
        mockClient = {
            disconnect: jest.fn(() => new Promise(resolve => {
                // 模拟断开连接需要 2 秒
                setTimeout(resolve, 2000);
            })),
            start: jest.fn().mockResolvedValue(undefined),
            connected: true
        };

        mockCoordinator = {
            acquireLock: jest.fn().mockResolvedValue(true),
            hasLock: jest.fn().mockResolvedValue(false),
            instanceId: "inst_1"
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * 模拟 index.js 中的 startTelegramClient 逻辑（适配新版本）
     */
    async function simulateStartTelegramClient(context) {
        // 检查是否已经持有锁（用于区分首次获取和续租）
        const alreadyHasLock = await mockCoordinator.hasLock("telegram_client");
        
        const hasLock = await mockCoordinator.acquireLock("telegram_client", 90);
        
        if (!hasLock) {
            if (context.isClientActive) {
                // 只有在真正失去锁时才记录警告日志
                console.log("🚨 失去 Telegram 锁，正在断开连接...");
                try {
                    // 核心逻辑：Promise.race 保护
                    await Promise.race([
                        mockClient.disconnect(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 5000))
                    ]);
                } catch (e) {
                    console.log("⚠️ 断开连接时出错:", e.message);
                }
                context.isClientActive = false;
            } else {
                // 静默续租失败，但客户端未激活，只需调试日志
                console.log("🔒 续租失败，客户端未激活");
            }
            context.hasLock = false;
            return false;
        }

        // 成功获取锁
        
        if (context.isClientActive) {
            // 续租成功，只在调试模式下记录
            if (alreadyHasLock) {
                console.log("🔒 静默续租成功");
            }
            return true;
        }
        
        // 首次获取锁，记录信息日志
        if (!alreadyHasLock) {
            console.log("👑 已获取 Telegram 锁，正在启动客户端...");
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
        await jest.advanceTimersByTimeAsync(2000);
        
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

        const logSpy = jest.fn();
        const originalLog = console.log;
        console.log = logSpy;
        
        const promise = simulateStartTelegramClient(context);
        
        // 推进时间超过 5s 保护阈值
        await jest.advanceTimersByTimeAsync(5100);
        
        await promise;
        
        expect(context.isClientActive).toBe(false);
        // 检查 log 调用的参数
        const timeoutLog = logSpy.mock.calls.find(call => call.join(' ').includes("Disconnect Timeout"));
        expect(timeoutLog).toBeDefined();
        
        console.log = originalLog;
    });

    test("should use 90s TTL for lock", async () => {
        const context = { isClientActive: false };
        await simulateStartTelegramClient(context);
        expect(mockCoordinator.acquireLock).toHaveBeenCalledWith("telegram_client", 90);
    });
});