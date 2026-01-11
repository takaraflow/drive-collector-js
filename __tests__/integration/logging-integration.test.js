import { jest, describe, test, expect, beforeEach, afterEach, afterAll, beforeAll } from "@jest/globals";
import { nativeConsole } from "../setup/consoleMock.js";

// ================== 1. Mock Axiom ==================
jest.unstable_mockModule('@axiomhq/js', () => ({
    Axiom: jest.fn() 
}));

// ================== 2. Mock Telegram Service (关键修复) ==================
jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    getClient: jest.fn().mockImplementation(async () => {
        if (!global._tgErrorHandler) {
            // 修复：模拟 GramJS 库的行为，将错误输出到 console.error
            // 这样我们的 Proxy 才能拦截到它
            global._tgErrorHandler = (err) => { console.error(err); };
        }
        return { 
            connected: true,
            on: jest.fn(),
            addEventHandler: jest.fn()
        };
    }),
    stopWatchdog: jest.fn().mockResolvedValue(undefined),
    reconnectBot: jest.fn().mockResolvedValue(undefined),
    startWatchdog: jest.fn().mockResolvedValue(undefined),
    client: { connected: true }
}));

// ================== 3. Mock Config ==================
jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: {
        apiId: 12345,
        apiHash: 'test-api-hash',
        axiom: {
            token: 'test-token',
            orgId: 'test-org',
            dataset: 'test-dataset'
        }
    }
}));

// ================== 4. Mock Repositories ==================
jest.unstable_mockModule('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: jest.fn().mockResolvedValue(''),
        set: jest.fn().mockResolvedValue(undefined)
    }
}));

jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        hasLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined)
    }
}));

describe('Logger Integration Tests (Unified)', () => {
    let originalConsole;
    let loggerModule;
    let telegramModule;
    let AxiomMock;
    let mockAxiomIngest;

    beforeAll(async () => {
        process.env.AXIOM_TOKEN = 'test-token';
        process.env.AXIOM_ORG_ID = 'test-org';
        process.env.AXIOM_DATASET = 'test-dataset';
        process.env.NODE_ENV = 'test';

        originalConsole = { ...console };
        
        const axiomModule = await import('@axiomhq/js');
        AxiomMock = axiomModule.Axiom;

        loggerModule = await import('../../src/services/logger.js');
        telegramModule = await import('../../src/services/telegram.js');
    });

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        jest.clearAllMocks();
        
        mockAxiomIngest = jest.fn().mockResolvedValue(undefined);

        AxiomMock.mockImplementation(() => ({
            ingest: mockAxiomIngest
        }));
        
        loggerModule.resetLogger();
        loggerModule.logger.configure({
            axiom: {
                token: 'test-token',
                orgId: 'test-org',
                dataset: 'test-dataset'
            }
        });

        Object.assign(console, originalConsole);

        jest.spyOn(console, 'error').mockImplementation((...args) => nativeConsole.error.call(console, ...args));
        jest.spyOn(console, 'warn').mockImplementation((...args) => nativeConsole.warn.call(console, ...args));
        jest.spyOn(console, 'log').mockImplementation((...args) => nativeConsole.log.call(console, ...args));
        jest.spyOn(console, 'info').mockImplementation((...args) => nativeConsole.info.call(console, ...args));
    });

    afterEach(async () => {
        loggerModule.disableTelegramConsoleProxy();
        await telegramModule.stopWatchdog();
        delete global._tgErrorHandler;
        
        await jest.runOnlyPendingTimersAsync();
        
        jest.restoreAllMocks();
        Object.assign(console, originalConsole);
        jest.useRealTimers();

        if (global.gc) global.gc();
    });

    afterAll(() => {
        jest.useRealTimers();
        delete process.env.AXIOM_TOKEN;
        delete process.env.AXIOM_ORG_ID;
        delete process.env.AXIOM_DATASET;
    });

    describe('Telegram TIMEOUT capture', () => {
        test('console.error proxy sends TIMEOUT to Axiom', async () => {
            loggerModule.enableTelegramConsoleProxy();

            console.error('TIMEOUT in updates.js');

            await Promise.resolve(); 
            await jest.advanceTimersByTimeAsync(1000);

            expect(mockAxiomIngest).toHaveBeenCalled();
            const payload = mockAxiomIngest.mock.calls[0][1][0];
            expect(payload.level).toBe('error');
            expect(payload.message).toContain('TIMEOUT captured');
        });

        test('Telegram client error handler sends TIMEOUT to Axiom', async () => {
            // 修复 1：开启代理，否则 console.error 不会被拦截
            loggerModule.enableTelegramConsoleProxy();

            await telegramModule.getClient();
            
            if (global._tgErrorHandler) {
                const timeoutError = new Error('Request timed out');
                timeoutError.code = 'ETIMEDOUT';
                
                // 触发 Mock 中定义的 console.error(err)
                global._tgErrorHandler(timeoutError);
                
                await Promise.resolve();
                await jest.advanceTimersByTimeAsync(1000);
                
                expect(mockAxiomIngest).toHaveBeenCalled();
            }
        });
    });

    describe('Other integrations', () => {
        test('logger includes version as separate field and clean message', async () => {
            await loggerModule.logger.info('test');
            
            await Promise.resolve();
            await jest.advanceTimersByTimeAsync(1000);
            
            expect(mockAxiomIngest).toHaveBeenCalled();
            const payload = mockAxiomIngest.mock.calls[0][1][0];
            // Message should be clean without version prefix
            expect(payload.message).toBe('test');
            // Version should be a separate field
            expect(payload.version).toBeDefined();
            expect(payload.version).not.toBe('unknown');
        });
    });
});
