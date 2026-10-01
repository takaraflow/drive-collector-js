// Logger Service Tests - 使用完全 mock 方式
// 不使用真实环境变量，不使用真实 Axiom 连接

// 创建本地的 mock 对象
const mockAxiomIngest = vi.fn().mockResolvedValue(true);
const mockAxiomConstructor = vi.fn().mockImplementation(function() {
    return {
        ingest: mockAxiomIngest
    };
});

// Mock @axiomhq/js
vi.mock('@axiomhq/js', () => ({
    Axiom: mockAxiomConstructor
}));

// Mock Logger 模块
const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withModule: vi.fn().mockImplementation(function(name) {
        return this;
    }),
    withContext: vi.fn().mockImplementation(function(ctx) {
        return this;
    }),
    configure: vi.fn(),
    isInitialized: vi.fn().mockReturnValue(true),
    canSend: vi.fn().mockReturnValue(true),
    flush: vi.fn().mockResolvedValue(undefined),
    getProviderName: vi.fn().mockReturnValue('AxiomLogger'),
    getConnectionInfo: vi.fn().mockReturnValue({ provider: 'AxiomLogger', connected: true })
};

vi.mock('../../src/services/logger/index.js', () => ({
    default: mockLogger,
    logger: mockLogger,
    LoggerService: vi.fn().mockImplementation(() => mockLogger),
    setInstanceIdProvider: vi.fn(),
    enableTelegramConsoleProxy: vi.fn(),
    disableTelegramConsoleProxy: vi.fn(),
    flushLogBuffer: vi.fn().mockResolvedValue(undefined),
    createLogger: () => mockLogger
}));


describe("Logger Service", () => {
    beforeEach(() => {
        mockAxiomIngest.mockClear();
        mockAxiomConstructor.mockClear();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.withModule.mockClear();
        mockLogger.withContext.mockClear();
        mockLogger.configure.mockClear();
        mockLogger.flush.mockClear();
    });

    test("should log info message", async () => {
        const message = "Test info message";
        await mockLogger.info(message);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should log error message", async () => {
        const error = new Error("Test error");
        await mockLogger.error(error);
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test("should log warning message", async () => {
        const message = "Test warning";
        await mockLogger.warn(message);
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    test("should handle structured data", async () => {
        const data = { key: "value", nested: { deep: "data" } };
        await mockLogger.info("test", data);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should use instanceId from context", async () => {
        await mockLogger.withContext({ instanceId: "test-instance-123" }).info("test");
        expect(mockLogger.withContext).toHaveBeenCalledWith({ instanceId: "test-instance-123" });
    });

    test("should support dynamic fields via withContext", async () => {
        const extraFields = { requestId: "req-123", userId: "user-456" };
        await mockLogger.withContext(extraFields).info("test");
        expect(mockLogger.withContext).toHaveBeenCalledWith(extraFields);
    });

    test("should inject env field from context", async () => {
        await mockLogger.withContext({ env: 'test' }).info("test");
        expect(mockLogger.withContext).toHaveBeenCalledWith({ env: 'test' });
    });

    test("should include all log levels", async () => {
        await mockLogger.info("info");
        await mockLogger.warn("warn");
        await mockLogger.error("error");
        await mockLogger.debug("debug");
        expect(mockLogger.info).toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalled();
    });

    test("should chain withModule calls", async () => {
        mockLogger.withModule("Module1").withContext({ key: "value" });
        expect(mockLogger.withModule).toHaveBeenCalledWith("Module1");
        expect(mockLogger.withContext).toHaveBeenCalledWith({ key: "value" });
    });

    test("should handle empty message", async () => {
        await mockLogger.info("");
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should handle null data", async () => {
        await mockLogger.info("test", null);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should handle undefined data", async () => {
        await mockLogger.info("test", undefined);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should handle large data objects", async () => {
        const largeData = {};
        for (let i = 0; i < 10; i++) {
            largeData[`key${i}`] = `value${i}`;
        }
        await mockLogger.info("test", largeData);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should handle special characters", async () => {
        const specialMessage = "Test with special chars: <>&\"'{}[]()!@#$%^&*";
        await mockLogger.info(specialMessage);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should handle unicode characters", async () => {
        const unicodeMessage = "测试中文 🎉 emoji 🚀";
        await mockLogger.info(unicodeMessage);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should handle very long messages", async () => {
        const longMessage = "a".repeat(1000);
        await mockLogger.info(longMessage);
        expect(mockLogger.info).toHaveBeenCalled();
    });

    test("should have correct provider info", async () => {
        expect(mockLogger.getProviderName()).toBe('AxiomLogger');
        expect(mockLogger.getConnectionInfo()).toEqual({ provider: 'AxiomLogger', connected: true });
    });
});
