import { jest } from "@jest/globals";

// Mock console methods
const mockConsole = {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn()
};

// 保存原始的 console
const originalConsole = global.console;

// 模拟全局错误处理逻辑（接受 processObj 参数以便测试）
function setupGlobalErrorHandling(processObj) {
    processObj.on("unhandledRejection", (reason, promise) => {
        console.error("🚨 未捕获的 Promise 拒绝:", reason);
    });

    processObj.on("uncaughtException", (err) => {
        console.error("🚨 未捕获的异常:", err);
        // 对于 TIMEOUT 错误，我们通常希望程序继续运行并由 Watchdog 处理
        if (err?.message?.includes("TIMEOUT")) {
            console.warn("⚠️ 忽略 TIMEOUT 导致的进程崩溃风险，等待 Watchdog 恢复...");
        } else {
            // 其他严重错误建议安全退出
            // process.exit(1);
        }
    });
}

describe("Global Error Handling", () => {
    let mockProcess;

    beforeEach(() => {
        // 【修复点】不再尝试复制 originalProcess 的属性。
        // 原始的 process 包含 stdin/stdout 等系统资源，复制它们会导致 TTYWRAP 错误。
        // 这里我们只需要 mock 函数中实际用到的 'on' 和 'exit' 方法。
        mockProcess = {
            on: jest.fn(),
            exit: jest.fn(),
        };

        // 替换 console
        global.console = mockConsole;

        // 重置 mocks
        mockConsole.error.mockClear();
        mockConsole.warn.mockClear();
        mockConsole.log.mockClear();
    });

    afterEach(() => {
        // 恢复原始的 console
        global.console = originalConsole;
    });

    test("应当能够设置全局错误处理程序", () => {
        setupGlobalErrorHandling(mockProcess);

        expect(mockProcess.on).toHaveBeenCalledWith("unhandledRejection", expect.any(Function));
        expect(mockProcess.on).toHaveBeenCalledWith("uncaughtException", expect.any(Function));
    });

    test("应当在 unhandledRejection 时记录错误", () => {
        setupGlobalErrorHandling(mockProcess);

        const rejectionHandler = mockProcess.on.mock.calls.find(
            ([event]) => event === "unhandledRejection"
        )[1];

        const mockReason = new Error("Test rejection");
        const mockPromise = {}; // 模拟 promise 对象

        rejectionHandler(mockReason, mockPromise);

        expect(mockConsole.error).toHaveBeenCalledWith("🚨 未捕获的 Promise 拒绝:", mockReason);
    });

    test("应当在 uncaughtException 时记录错误", () => {
        setupGlobalErrorHandling(mockProcess);

        const exceptionHandler = mockProcess.on.mock.calls.find(
            ([event]) => event === "uncaughtException"
        )[1];

        const mockError = new Error("Test exception");
        exceptionHandler(mockError);

        expect(mockConsole.error).toHaveBeenCalledWith("🚨 未捕获的异常:", mockError);
    });

    test("应当在 TIMEOUT uncaughtException 时仅记录警告而不退出进程", () => {
        setupGlobalErrorHandling(mockProcess);

        const exceptionHandler = mockProcess.on.mock.calls.find(
            ([event]) => event === "uncaughtException"
        )[1];

        const mockTimeoutError = new Error("TIMEOUT occurred in update loop");
        exceptionHandler(mockTimeoutError);

        expect(mockConsole.error).toHaveBeenCalledWith("🚨 未捕获的异常:", mockTimeoutError);
        expect(mockConsole.warn).toHaveBeenCalledWith("⚠️ 忽略 TIMEOUT 导致的进程崩溃风险，等待 Watchdog 恢复...");
        expect(mockProcess.exit).not.toHaveBeenCalled();
    });

    test("应当在非 TIMEOUT uncaughtException 时不自动退出进程（注释掉的逻辑）", () => {
        setupGlobalErrorHandling(mockProcess);

        const exceptionHandler = mockProcess.on.mock.calls.find(
            ([event]) => event === "uncaughtException"
        )[1];

        const mockOtherError = new Error("Some other critical error");
        exceptionHandler(mockOtherError);

        expect(mockConsole.error).toHaveBeenCalledWith("🚨 未捕获的异常:", mockOtherError);
        // Note: The code has process.exit(1) commented out for non-TIMEOUT errors,
        // so we don't expect it to be called in this test
        expect(mockProcess.exit).not.toHaveBeenCalled();
    });

    test("应当正确识别 TIMEOUT 错误消息", () => {
        setupGlobalErrorHandling(mockProcess);

        const exceptionHandler = mockProcess.on.mock.calls.find(
            ([event]) => event === "uncaughtException"
        )[1];

        // 测试各种 TIMEOUT 错误消息格式
        const timeoutErrors = [
            new Error("TIMEOUT"),
            new Error("TIMEOUT occurred in update loop"),
            new Error("Request TIMEOUT"),
            new Error("Some error with TIMEOUT inside")
        ];

        timeoutErrors.forEach(error => {
            mockConsole.warn.mockClear();
            exceptionHandler(error);
            expect(mockConsole.warn).toHaveBeenCalledWith("⚠️ 忽略 TIMEOUT 导致的进程崩溃风险，等待 Watchdog 恢复...");
        });

        // 测试非 TIMEOUT 错误
        const nonTimeoutError = new Error("Some other error");
        mockConsole.warn.mockClear();
        exceptionHandler(nonTimeoutError);
        expect(mockConsole.warn).not.toHaveBeenCalled();
    });
});
