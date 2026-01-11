import { gracefulShutdown, registerShutdownHook } from "../../src/services/GracefulShutdown.js";

describe("GracefulShutdown Integration", () => {
    let mockExit;
    let originalConsole;

    beforeEach(() => {
        mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {});

        originalConsole = {
            error: global.console.error,
            warn: global.console.warn,
            log: global.console.log,
            info: global.console.info
        };

        // Mock console
        global.console = {
            error: vi.fn(),
            warn: vi.fn(),
            log: vi.fn(),
            info: vi.fn()
        };
    });

    afterEach(() => {
        mockExit.mockRestore();
        global.console = originalConsole;
        gracefulShutdown.isShuttingDown = false;
        gracefulShutdown.exitCode = 0;
        gracefulShutdown.shutdownHooks = [];
    });

    describe("Full Shutdown Flow", () => {
        test("完整的优雅关闭流程", async () => {
            const executionLog = [];

            const httpServerHook = vi.fn().mockImplementation(async () => {
                executionLog.push('http-server');
            });

            const instanceCoordinatorHook = vi.fn().mockImplementation(async () => {
                executionLog.push('instance-coordinator');
            });

            const telegramHook = vi.fn().mockImplementation(async () => {
                executionLog.push('telegram');
            });

            const taskRepoHook = vi.fn().mockImplementation(async () => {
                executionLog.push('task-repository');
            });

            const cacheHook = vi.fn().mockImplementation(async () => {
                executionLog.push('cache');
            });

            registerShutdownHook(httpServerHook, 10, 'http-server');
            registerShutdownHook(instanceCoordinatorHook, 20, 'instance-coordinator');
            registerShutdownHook(telegramHook, 30, 'telegram');
            registerShutdownHook(taskRepoHook, 40, 'task-repository');
            registerShutdownHook(cacheHook, 50, 'cache');

            await gracefulShutdown.executeCleanupHooks();

            expect(executionLog).toEqual([
                'http-server',
                'instance-coordinator',
                'telegram',
                'task-repository',
                'cache'
            ]);

            expect(httpServerHook).toHaveBeenCalled();
            expect(instanceCoordinatorHook).toHaveBeenCalled();
            expect(telegramHook).toHaveBeenCalled();
            expect(taskRepoHook).toHaveBeenCalled();
            expect(cacheHook).toHaveBeenCalled();
        });

        test("关闭失败时记录错误并继续", async () => {
            const successHook = vi.fn().mockResolvedValue();
            const failingHook = vi.fn().mockRejectedValue(new Error('Hook failed'));

            registerShutdownHook(successHook, 10, 'success-hook');
            registerShutdownHook(failingHook, 20, 'failing-hook');
            registerShutdownHook(successHook, 30, 'success-hook-2');

            await gracefulShutdown.executeCleanupHooks();

            expect(successHook).toHaveBeenCalledTimes(2);
            expect(failingHook).toHaveBeenCalled();
        });
    });

    describe("Edge Cases", () => {
        test("没有注册任何关闭钩子", async () => {
            expect(gracefulShutdown.shutdownHooks.length).toBe(0);

            await gracefulShutdown.executeCleanupHooks();

            expect(mockExit).not.toHaveBeenCalled();
        });

        test("关闭钩子本身抛出同步错误应该被捕获", async () => {
            const syncErrorHook = vi.fn(() => {
                throw new Error('Synchronous error');
            });

            registerShutdownHook(syncErrorHook, 10, 'sync-error-hook');

            // 这个测试应该能够执行完成而不抛出异常
            await expect(gracefulShutdown.executeCleanupHooks()).resolves.toBeUndefined();
        });
    });

    describe("Performance", () => {
        test("关闭流程应该在合理时间内完成", async () => {
            const fastHook = vi.fn().mockResolvedValue();
            registerShutdownHook(fastHook, 10, 'fast-hook');

            const startTime = Date.now();
            await gracefulShutdown.executeCleanupHooks();
            const duration = Date.now() - startTime;

            expect(fastHook).toHaveBeenCalled();
            expect(duration).toBeLessThan(15);
        });
    });
});
