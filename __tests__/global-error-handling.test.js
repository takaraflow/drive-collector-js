import { gracefulShutdown } from "../src/services/GracefulShutdown.js";

vi.mock("../src/services/logger/index.js", () => {
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockImplementation((name) => mockLogger),
        withContext: vi.fn().mockImplementation((ctx) => mockLogger),
        configure: vi.fn(),
        isInitialized: vi.fn().mockReturnValue(true),
        canSend: vi.fn().mockReturnValue(true)
    };
    return {
        default: mockLogger,
        logger: mockLogger,
        setInstanceIdProvider: vi.fn(),
        enableTelegramConsoleProxy: vi.fn(),
        disableTelegramConsoleProxy: vi.fn()
    };
});

describe("Global Error Handling with Graceful Shutdown", () => {
    let originalConsole;

    beforeEach(() => {
        originalConsole = {
            error: global.console.error,
            warn: global.console.warn,
            log: global.console.log,
            info: global.console.info
        };

        global.console = {
            error: vi.fn(),
            warn: vi.fn(),
            log: vi.fn(),
            info: vi.fn()
        };

        gracefulShutdown.isShuttingDown = false;
        gracefulShutdown.exitCode = 0;
        gracefulShutdown.shutdownHooks = [];
    });

    afterEach(() => {
        global.console = originalConsole;
        gracefulShutdown.isShuttingDown = false;
        gracefulShutdown.exitCode = 0;
        gracefulShutdown.shutdownHooks = [];
    });

    describe("Error Recovery", () => {
        test("应当识别 TIMEOUT 错误为可恢复", () => {
            const timeoutError = new Error("TIMEOUT occurred in update loop");
            expect(gracefulShutdown.isRecoverableError(timeoutError)).toBe(true);
        });

        test("应当识别网络错误为可恢复", () => {
            const networkErrors = [
                new Error("ECONNREFUSED"),
                new Error("ECONNRESET"),
                new Error("ETIMEDOUT"),
                new Error("Network error"),
                new Error("Connection lost")
            ];

            networkErrors.forEach(error => {
                expect(gracefulShutdown.isRecoverableError(error)).toBe(true);
            });
        });

        test("应当识别 FLOOD 错误为可恢复", () => {
            const floodError = new Error("FLOOD wait exceeded");
            expect(gracefulShutdown.isRecoverableError(floodError)).toBe(true);
        });

        test("应当将非恢复性错误标记为不可恢复", () => {
            const fatalError = new Error("Fatal error: corrupted memory");
            expect(gracefulShutdown.isRecoverableError(fatalError)).toBe(false);
        });
    });

    describe("Shutdown Process", () => {
        test("应当能够注册关闭钩子", () => {
            const mockCleanup = vi.fn().mockResolvedValue();

            gracefulShutdown.register(mockCleanup, 10, 'test-hook');

            expect(gracefulShutdown.shutdownHooks).toHaveLength(1);
            expect(gracefulShutdown.shutdownHooks[0].name).toBe('test-hook');
        });

        test("应该按照优先级排序关闭钩子", () => {
            const hook1 = vi.fn().mockResolvedValue();
            const hook2 = vi.fn().mockResolvedValue();
            const hook3 = vi.fn().mockResolvedValue();

            gracefulShutdown.register(hook2, 20, 'hook2');
            gracefulShutdown.register(hook1, 10, 'hook1');
            gracefulShutdown.register(hook3, 30, 'hook3');

            expect(gracefulShutdown.shutdownHooks[0].name).toBe('hook1');
            expect(gracefulShutdown.shutdownHooks[1].name).toBe('hook2');
            expect(gracefulShutdown.shutdownHooks[2].name).toBe('hook3');
        });

        test("即使某个钩子失败，也应该继续执行其他钩子", async () => {
            const hook1 = vi.fn().mockResolvedValue();
            const hook2 = vi.fn().mockRejectedValue(new Error('Hook 2 failed'));
            const hook3 = vi.fn().mockResolvedValue();

            gracefulShutdown.register(hook1, 10, 'hook1');
            gracefulShutdown.register(hook2, 20, 'hook2');
            gracefulShutdown.register(hook3, 30, 'hook3');

            await gracefulShutdown.executeCleanupHooks();

            expect(hook1).toHaveBeenCalled();
            expect(hook2).toHaveBeenCalled();
            expect(hook3).toHaveBeenCalled();
        });
    });

    describe("Exit Code Management", () => {
        test("默认退出码应该为 0", () => {
            expect(gracefulShutdown.exitCode).toBe(0);
        });

        test("可以通过设置退出码来改变退出状态", () => {
            gracefulShutdown.exitCode = 1;
            expect(gracefulShutdown.exitCode).toBe(1);
        });
    });
});

