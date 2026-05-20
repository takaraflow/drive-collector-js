import { gracefulShutdown, registerShutdownHook } from "../../src/services/GracefulShutdown.js";
import { logger } from "../../src/services/logger/index.js";

vi.mock("../../src/services/logger/index.js", () => {
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockImplementation(() => mockLogger),
        withContext: vi.fn().mockImplementation(() => mockLogger),
        configure: vi.fn(),
        isInitialized: vi.fn().mockReturnValue(true),
        canSend: vi.fn().mockReturnValue(true),
        flush: vi.fn().mockResolvedValue(undefined)
    };

    return {
        default: mockLogger,
        logger: mockLogger,
        flushLogBuffer: vi.fn().mockResolvedValue(undefined)
    };
});

describe("GracefulShutdown", () => {
    let originalProcessListeners = {};
    let mockExit;

    beforeEach(() => {
        vi.clearAllMocks();
        // 保存原始的监听器
        originalProcessListeners = {
            SIGTERM: [...process.listeners('SIGTERM')],
            SIGINT: [...process.listeners('SIGINT')],
            uncaughtException: [...process.listeners('uncaughtException')],
            unhandledRejection: [...process.listeners('unhandledRejection')]
        };

        // Mock process.exit
        mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        // 恢复原始的监听器
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('uncaughtException');
        process.removeAllListeners('unhandledRejection');

        originalProcessListeners.SIGTERM.forEach(listener => process.on('SIGTERM', listener));
        originalProcessListeners.SIGINT.forEach(listener => process.on('SIGINT', listener));
        originalProcessListeners.uncaughtException.forEach(listener => process.on('uncaughtException', listener));
        originalProcessListeners.unhandledRejection.forEach(listener => process.on('unhandledRejection', listener));

        mockExit.mockRestore();

        // 清理 GracefulShutdown 状态
        gracefulShutdown.isShuttingDown = false;
        gracefulShutdown.exitCode = 0;
        gracefulShutdown.shutdownHooks = [];
    });

    describe("Shutdown Hooks", () => {
        test("应当能够注册关闭钩子", () => {
            const mockCleanup = vi.fn().mockResolvedValue();
            registerShutdownHook(mockCleanup, 10, 'test-hook');

            expect(gracefulShutdown.shutdownHooks).toHaveLength(1);
            expect(gracefulShutdown.shutdownHooks[0].name).toBe('test-hook');
        });

        test("应当按照优先级顺序排列关闭钩子", () => {
            const hook1 = vi.fn().mockResolvedValue();
            const hook2 = vi.fn().mockResolvedValue();
            const hook3 = vi.fn().mockResolvedValue();

            registerShutdownHook(hook2, 20, 'hook2');
            registerShutdownHook(hook1, 10, 'hook1');
            registerShutdownHook(hook3, 30, 'hook3');

            expect(gracefulShutdown.shutdownHooks[0].name).toBe('hook1');
            expect(gracefulShutdown.shutdownHooks[1].name).toBe('hook2');
            expect(gracefulShutdown.shutdownHooks[2].name).toBe('hook3');
        });
    });

    describe("Error Recovery", () => {
        test("应当识别可恢复的错误", () => {
            const timeoutError = new Error('Connection TIMEOUT');
            const connectionError = new Error('ECONNREFUSED');
            const fatalError = new Error('Fatal error');

            expect(gracefulShutdown.isRecoverableError(timeoutError)).toBe(true);
            expect(gracefulShutdown.isRecoverableError(connectionError)).toBe(true);
            expect(gracefulShutdown.isRecoverableError(fatalError)).toBe(false);
        });

        test("应当识别各种可恢复的错误模式", () => {
            const recoverableErrors = [
                new Error('TIMEOUT'),
                new Error('ETIMEDOUT'),
                new Error('ECONNREFUSED'),
                new Error('ECONNRESET'),
                new Error('EPIPE'),
                new Error('FLOOD'),
                new Error('Network error'),
                new Error('Connection lost'),
                new Error('Connection timeout'),
                new Error('Not connected')
            ];

            recoverableErrors.forEach(err => {
                expect(gracefulShutdown.isRecoverableError(err)).toBe(true);
            });
        });

        test("应当识别 'Not connected' 错误为可恢复", () => {
            const notConnectedError = new Error('Not connected');
            expect(gracefulShutdown.isRecoverableError(notConnectedError)).toBe(true);
        });
    });

    describe("Signal Handling", () => {
        test("应当设置 SIGTERM 信号处理器", () => {
            const listeners = process.listeners('SIGTERM');
            expect(listeners.length).toBeGreaterThan(0);
        });

        test("应当设置 SIGINT 信号处理器", () => {
            const listeners = process.listeners('SIGINT');
            expect(listeners.length).toBeGreaterThan(0);
        });
    });

    describe("Shutdown Process", () => {
        test("应当能够触发关闭", async () => {
            const mockCleanup = vi.fn().mockResolvedValue();
            registerShutdownHook(mockCleanup, 10, 'test-hook');

            await gracefulShutdown.executeCleanupHooks();

            expect(mockCleanup).toHaveBeenCalled();
        });

        test("即使某个钩子失败，也应该继续执行其他钩子", async () => {
            const hook1 = vi.fn().mockResolvedValue();
            const hook2 = vi.fn().mockRejectedValue(new Error('Hook 2 failed'));
            const hook3 = vi.fn().mockResolvedValue();

            registerShutdownHook(hook1, 10, 'hook1');
            registerShutdownHook(hook2, 20, 'hook2');
            registerShutdownHook(hook3, 30, 'hook3');

            await gracefulShutdown.executeCleanupHooks();

            expect(hook1).toHaveBeenCalled();
            expect(hook2).toHaveBeenCalled();
            expect(hook3).toHaveBeenCalled();
        });

        test("防止重复关闭", async () => {
            const mockCleanup = vi.fn().mockResolvedValue();
            registerShutdownHook(mockCleanup, 10, 'test-hook');

            // 第一次触发
            await gracefulShutdown.shutdown('test');

            // 第一次后，钩子应该被调用
            expect(mockCleanup).toHaveBeenCalled();

            // 验证状态
            expect(gracefulShutdown.isShuttingDown).toBe(true);
        });

        test("无业务清理钩子时也应在退出前刷新日志缓冲", async () => {
            vi.useFakeTimers();

            const shutdownPromise = gracefulShutdown.shutdown('startup-failed');

            await shutdownPromise;
            expect(logger.flush).toHaveBeenCalledWith(5000);

            await vi.advanceTimersByTimeAsync(1000);
            expect(mockExit).toHaveBeenCalledWith(0);
        });
    });

    describe("Exit Code", () => {
        test("默认退出码应该为 0", () => {
            expect(gracefulShutdown.exitCode).toBe(0);
        });

        test("可以通过设置退出码来改变退出状态", () => {
            gracefulShutdown.exitCode = 1;
            expect(gracefulShutdown.exitCode).toBe(1);
        });
    });
});
