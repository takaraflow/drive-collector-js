import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

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

describe("Logger Service", () => {
    let mockAxiomIngest;
    let mockAxiomConstructor;
    let logger;
    let consoleInfoSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;
    let consoleLogSpy;
    let enableTelegramConsoleProxy;
    let disableTelegramConsoleProxy;
    let setInstanceIdProvider;

    const getLastAxiomCall = () => {
        const calls = mockAxiomIngest.mock.calls;
        if (!calls.length) {
            throw new Error('Axiom ingest was not invoked');
        }
        const [dataset, [payload]] = calls[calls.length - 1];
        return { dataset, payload };
    };

    beforeEach(async () => {
        process.env.AXIOM_TOKEN = 'test-token';
        process.env.AXIOM_ORG_ID = 'test-org';
        process.env.AXIOM_DATASET = 'test-dataset';

        // Mock environment access instead of process.env
        await jest.unstable_mockModule('../../src/config/env.js', () => ({
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

        jest.useFakeTimers();

        // Mock time provider
        await jest.unstable_mockModule('../../src/utils/timeProvider.js', () => ({
            getTime: mockTimeProvider.now,
            timers: mockTimeProvider
        }));

        // Mock Axiom
        mockAxiomIngest = jest.fn().mockResolvedValue(undefined);
        mockAxiomConstructor = jest.fn(() => ({
            ingest: mockAxiomIngest
        }));

        await jest.unstable_mockModule('@axiomhq/js', () => ({
            Axiom: mockAxiomConstructor
        }));

        // Spy on console methods BEFORE importing logger
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        jest.clearAllMocks();
        jest.resetModules();

        // Import logger after mocks are set
        const loggerModule = await import('../../src/services/logger.js');
        logger = loggerModule.default;
        enableTelegramConsoleProxy = loggerModule.enableTelegramConsoleProxy;
        disableTelegramConsoleProxy = loggerModule.disableTelegramConsoleProxy;
        setInstanceIdProvider = loggerModule.setInstanceIdProvider;
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        process.env.AXIOM_TOKEN = savedEnv.AXIOM_TOKEN;
        process.env.AXIOM_ORG_ID = savedEnv.AXIOM_ORG_ID;
        process.env.AXIOM_DATASET = savedEnv.AXIOM_DATASET;
    });

    test("should log info message", async () => {
        const moduleName = "TestModule";
        const message = "Test info message";
        
        await logger.withModule(moduleName).info(message);
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            level: "info",
            message: expect.stringContaining(message),
            module: moduleName,
            timestamp: expect.any(String)
        }));
    });

    test("should log error message", async () => {
        const moduleName = "TestModule";
        const error = new Error("Test error");
        
        await logger.withModule(moduleName).error(error);
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            level: "error",
            message: expect.stringContaining(error.message),
            module: moduleName,
            timestamp: expect.any(String)
        }));
    });

    test("should log warning message", async () => {
        const moduleName = "TestModule";
        const message = "Test warning";
        
        await logger.withModule(moduleName).warn(message);
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload).toEqual(expect.objectContaining({
            level: "warn",
            message: expect.stringContaining(message),
            module: moduleName,
            timestamp: expect.any(String)
        }));
    });

    test("should use console fallback when Axiom is not configured", async () => {
        // Mock Axiom not configured
        await jest.unstable_mockModule('@axiomhq/js', () => ({
            Axiom: null
        }));
        process.env.AXIOM_TOKEN = undefined;
        process.env.AXIOM_ORG_ID = undefined;
        process.env.AXIOM_DATASET = undefined;
        await jest.unstable_mockModule('../../src/config/env.js', () => ({
            getEnv: () => ({
                DEBUG: 'true',
                APP_VERSION: 'test-version',
                AXIOM_TOKEN: undefined,
                AXIOM_ORG_ID: undefined,
                AXIOM_DATASET: undefined
            }),
            DEBUG: 'true',
            APP_VERSION: 'test-version'
        }));
        
        // Reset module to get new instance
        jest.resetModules();
        const loggerModule = await import('../../src/services/logger.js');
        const fallbackLogger = loggerModule.default;
        
        const moduleName = "TestModule";
        const message = "Test message";
        
        await fallbackLogger.withModule(moduleName).info(message);
        
        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining(message),
            expect.any(Object)
        );
    });

    test("should handle structured data", async () => {
        const moduleName = "TestModule";
        const message = "Structured data test";
        const data = { userId: 123, action: "test" };
        
        await logger.withModule(moduleName).info(message, { data });
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload.details).toContain('"userId":123');
    });

    test("should truncate long messages", async () => {
        const moduleName = "TestModule";
        const longMessage = "x".repeat(10000);
        
        await logger.withModule(moduleName).info(longMessage);
        
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
        mockAxiomIngest
            .mockRejectedValueOnce(new Error("Axiom error"))
            .mockResolvedValueOnce(undefined);
        
        const moduleName = "TestModule";
        const message = "Test error handling";
        
        const logPromise = logger.withModule(moduleName).info(message);
        jest.advanceTimersByTime(1000);
        await logPromise;

        const { dataset } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
    });

    test("suspends Axiom when service is unavailable", async () => {
        mockAxiomIngest.mockRejectedValueOnce(new Error("Service unavailable"));

        const moduleName = "TestModule";
        const firstLogPromise = logger.withModule(moduleName).info("first message");
        jest.advanceTimersByTime(5000);
        await firstLogPromise;
        const callsAfterFirst = mockAxiomIngest.mock.calls.length;
        await logger.withModule(moduleName).info("second message");

        expect(mockAxiomIngest).toHaveBeenCalledTimes(callsAfterFirst);
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
        
        const { dataset } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
    });

    test("should format dates consistently", async () => {
        const moduleName = "TestModule";
        const date = new Date(fixedTime);
        jest.setSystemTime(fixedTime);
        
        await logger.withModule(moduleName).info("Date test", { date });
        
        const { dataset, payload } = getLastAxiomCall();
        expect(dataset).toBe('test-dataset');
        expect(payload.timestamp).toBe(new Date(fixedTime).toISOString());
        expect(payload.module).toBe(moduleName);
    });
});
