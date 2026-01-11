// Fixed time for deterministic tests
const fixedTime = 1699970000000; // Nov 14 2023

// Mock time provider
const mockTimeProvider = {
    now: () => fixedTime,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout
};

const savedEnv = {
    AXIOM_TOKEN: process.env.AXIOM_TOKEN,
    AXIOM_ORG_ID: process.env.AXIOM_ORG_ID,
    AXIOM_DATASET: process.env.AXIOM_DATASET
};

// Import global mocks from external-mocks.js
import { globalMocks, mockAxiomIngest, mockAxiomConstructor } from '../setup/external-mocks.js';

// Mock modules at top level
vi.mock('@axiomhq/js', () => ({
    Axiom: globalMocks.axiomConstructor
}));

vi.mock('../../src/config/env.js', () => ({
    getEnv: () => ({
        DEBUG: 'true',
        APP_VERSION: 'test-version',
        AXIOM_TOKEN: 'test-token',
        AXIOM_ORG_ID: 'test-org',
        AXIOM_DATASET: 'test-dataset'
    }),
    DEBUG: 'true',
    APP_VERSION: 'test-version',
    AXIOM_TOKEN: 'test-token',
    AXIOM_ORG_ID: 'test-org',
    AXIOM_DATASET: 'test-dataset'
}));

vi.mock('../../src/utils/timeProvider.js', () => ({
    getTime: () => 1699970000000,
    timers: {
        now: () => 1699970000000,
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout
    }
}));

describe("Logger Service", () => {
    let logger;
    let consoleInfoSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;
    let consoleLogSpy;
    let enableTelegramConsoleProxy;
    let disableTelegramConsoleProxy;
    let setInstanceIdProvider;
    let flushLogBuffer;
    let resetLogger;

    const getLastAxiomCall = () => {
        const calls = globalMocks.axiomIngest.mock.calls;
        if (!calls.length) {
            throw new Error('Axiom ingest was not invoked');
        }
        const [dataset, payloadArray] = calls[calls.length - 1];
        if (!Array.isArray(payloadArray) || !payloadArray.length) {
            throw new Error('Axiom payload was not sent as an array');
        }
        const payload = payloadArray[payloadArray.length - 1];
        return { dataset, payload };
    };

    beforeEach(async () => {
        process.env.AXIOM_TOKEN = 'test-token';
        process.env.AXIOM_ORG_ID = 'test-org';
        process.env.AXIOM_DATASET = 'test-dataset';

        vi.useFakeTimers();

        // Clear global mocks
        globalMocks.axiomIngest.mockClear();
        globalMocks.axiomConstructor.mockClear();

        // Reset modules to ensure fresh import
        vi.resetModules();

        // Spy on console methods BEFORE importing logger
        // This ensures logger captures the spied console methods as originalConsoleLog
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // Import logger and reset it
        const loggerModule = await import('../../src/services/logger.js');
        logger = loggerModule.default;
        enableTelegramConsoleProxy = loggerModule.enableTelegramConsoleProxy;
        disableTelegramConsoleProxy = loggerModule.disableTelegramConsoleProxy;
        setInstanceIdProvider = loggerModule.setInstanceIdProvider;
        flushLogBuffer = loggerModule.flushLogBuffer;
        resetLogger = loggerModule.resetLogger;
        
        // Call updateOriginalConsole if it exists
        if (loggerModule.updateOriginalConsole) {
            loggerModule.updateOriginalConsole();
        }
        
        resetLogger();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        process.env.AXIOM_TOKEN = savedEnv.AXIOM_TOKEN;
        process.env.AXIOM_ORG_ID = savedEnv.AXIOM_ORG_ID;
        process.env.AXIOM_DATASET = savedEnv.AXIOM_DATASET;
    });

    test("should log info message with clean message and separate fields", async () => {
        const moduleName = "TestModule";
        const message = "Test info message";
        
        await logger.withModule(moduleName).info(message);
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            level: "info",
            message: message, // Exact match, no prefixes
            module: moduleName,
            version: expect.any(String),
            timestamp: expect.any(String)
        }));
    });

    test("should log error message with clean message and separate fields", async () => {
        const moduleName = "TestModule";
        const error = new Error("Test error");
        
        await logger.withModule(moduleName).error(error);
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            level: "error",
            message: error.message, // Exact match
            module: moduleName,
            version: expect.any(String),
            timestamp: expect.any(String)
        }));
    });

    test("should log warning message with clean message and separate fields", async () => {
        const moduleName = "TestModule";
        const message = "Test warning";
        
        await logger.withModule(moduleName).warn(message);
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            level: "warn",
            message: message, // Exact match
            module: moduleName,
            version: expect.any(String),
            timestamp: expect.any(String)
        }));
    });

    test("should use console fallback when Axiom is not configured", async () => {
        // Clear environment
        process.env.AXIOM_TOKEN = '';
        process.env.AXIOM_ORG_ID = '';
        process.env.AXIOM_DATASET = '';
        
        // Re-import logger to pick up the cleared environment
        const loggerModule = await import('../../src/services/logger.js');
        logger = loggerModule.default;
        resetLogger = loggerModule.resetLogger;
        flushLogBuffer = loggerModule.flushLogBuffer;
        
        resetLogger();
        
        const moduleName = "TestModule";
        const message = "Test message";
        
        // Call info and flush buffer
        await logger.withModule(moduleName).info(message);
        await flushLogBuffer();
        
        // Check that console.log was called - use console.log directly since originalConsoleLog is captured at module load
        // The logger will call originalConsoleLog which is the real console.log, but we can check the output
        expect(consoleLogSpy).toHaveBeenCalled();
        
        // Check the call contains our message
        const calls = consoleLogSpy.mock.calls;
        const hasMessage = calls.some(call =>
            call[0] && typeof call[0] === 'string' && call[0].includes(message)
        );
        expect(hasMessage).toBe(true);
    });

    test("should handle structured data", async () => {
        const moduleName = "TestModule";
        const message = "Structured data test";
        const data = { userId: 123, action: "test" };
        
        await logger.withModule(moduleName).info(message, { data });
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload.details).toContain('"userId":123');
    });

    test("should truncate long messages", async () => {
        const moduleName = "TestModule";
        const longMessage = "x".repeat(10000);
        
        await logger.withModule(moduleName).info(longMessage);
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload.details.length).toBeLessThan(longMessage.length);
    });

    test("should use instanceId when set", async () => {
        const instanceId = "test-instance-123";
        
        setInstanceIdProvider(() => instanceId);
        
        const moduleName = "TestModule";
        const message = "Test with instance";
        
        await logger.withModule(moduleName).info(message);
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            instanceId: instanceId,
            module: moduleName,
            timestamp: expect.any(String)
        }));
    });

    test("should enable and disable Telegram console proxy", () => {
        expect(enableTelegramConsoleProxy).toBeDefined();
        expect(disableTelegramConsoleProxy).toBeDefined();
        
        enableTelegramConsoleProxy();
        // Should have set up console proxy
        
        disableTelegramConsoleProxy();
        // Should have restored console
    });

    test("should handle ingest errors gracefully", async () => {
        globalMocks.axiomIngest
            .mockRejectedValueOnce(new Error("Axiom error"))
            .mockResolvedValueOnce(undefined);
        
        const moduleName = "TestModule";
        const message = "Test error handling";
        
        await logger.withModule(moduleName).info(message);
        await flushLogBuffer();

        const { dataset } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
    });

    test("suspends Axiom when service is unavailable", async () => {
        // First call will fail and trigger suspension
        globalMocks.axiomIngest.mockRejectedValueOnce(new Error("Service unavailable"));

        const moduleName = "TestModule";
        
        // First message - should fail and suspend
        await logger.withModule(moduleName).info("first message");
        await flushLogBuffer();
        
        const callsAfterFirst = globalMocks.axiomIngest.mock.calls.length;
        
        // Second message - should use console fallback due to suspension
        await logger.withModule(moduleName).info("second message");
        await flushLogBuffer();

        // Should not have made additional Axiom calls due to suspension
        expect(globalMocks.axiomIngest).toHaveBeenCalledTimes(callsAfterFirst);
        
        // Should have logged to console
        expect(
            consoleLogSpy.mock.calls.some(
                (call) => typeof call[0] === 'string' && call[0].includes("second message")
            )
        ).toBe(true);
    });

    test("should handle circular references in data", async () => {
        const moduleName = "TestModule";
        const circularData = {};
        circularData.self = circularData;
        
        await logger.withModule(moduleName).info("Circular test", { data: circularData });
        await flushLogBuffer();
        
        // Check that Axiom ingest was called
        expect(globalMocks.axiomIngest).toHaveBeenCalled();
        
        const { dataset } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
    });

    test("should format dates consistently", async () => {
        const moduleName = "TestModule";
        const date = new Date(fixedTime);
        vi.setSystemTime(fixedTime);
        
        await logger.withModule(moduleName).info("Date test", { date });
        await flushLogBuffer();
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload.timestamp).toBe(new Date(fixedTime).toISOString());
        expect(payload.module).toBe(moduleName);
    });

    test("should support dynamic fields via withContext", async () => {
        const dynamicFields = {
            taskId: "T-123",
            userId: "U-456",
            customFlag: true
        };
        
        await logger.withContext(dynamicFields).info("Dynamic fields test");
        await flushLogBuffer();
        
        const { payload } = getLastAxiomCall();
        
        // Dynamic fields should be at the top level of the payload
        expect(payload.taskId).toBe("T-123");
        expect(payload.userId).toBe("U-456");
        expect(payload.customFlag).toBe(true);
        expect(payload.message).toBe("Dynamic fields test");
    });
});
