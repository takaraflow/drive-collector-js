import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_CONSOLE_SYMBOL = Symbol.for('driveCollector.logger.originalConsole');

let loggerModule;
let originalEnv;

const waitForAsyncConsoleLog = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
};

const buildGramJsUpdateLoopTimeout = () => {
    const error = new Error('TIMEOUT');
    error.stack = [
        'Error: TIMEOUT',
        '    at /app/node_modules/telegram/client/updates.js:250:85',
        '    at async attempts (/app/node_modules/telegram/client/updates.js:234:20)',
        '    at async _updateLoop (/app/node_modules/telegram/client/updates.js:184:17)'
    ].join('\n');
    return error;
};

const importFreshLoggerWithConsoleSpies = async () => {
    vi.resetModules();
    delete globalThis[ORIGINAL_CONSOLE_SYMBOL];

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    loggerModule = await import('../../../src/services/logger/LoggerService.js');
    return { ...loggerModule, errorSpy, warnSpy, logSpy };
};

describe('Telegram console proxy', () => {
    beforeEach(() => {
        originalEnv = {
            LOG_LEVEL: process.env.LOG_LEVEL,
            NODE_ENV: process.env.NODE_ENV,
            AXIOM_TOKEN: process.env.AXIOM_TOKEN,
            AXIOM_ORG_ID: process.env.AXIOM_ORG_ID,
            NEW_RELIC_LICENSE_KEY: process.env.NEW_RELIC_LICENSE_KEY
        };

        process.env.NODE_ENV = 'test';
        process.env.LOG_LEVEL = 'debug';
        delete process.env.AXIOM_TOKEN;
        delete process.env.AXIOM_ORG_ID;
        delete process.env.NEW_RELIC_LICENSE_KEY;
    });

    afterEach(() => {
        if (loggerModule?.disableTelegramConsoleProxy) {
            loggerModule.disableTelegramConsoleProxy();
        }
        delete globalThis[ORIGINAL_CONSOLE_SYMBOL];

        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }

        vi.restoreAllMocks();
    });

    test('does not recurse when the proxy is enabled before the console logger is initialized', async () => {
        const { LoggerService, enableTelegramConsoleProxy, errorSpy, warnSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        console.error(new Error('TIMEOUT'));
        await waitForAsyncConsoleLog();

        const renderedCalls = errorSpy.mock.calls.map(call => call.map(String).join(' '));
        const warnCalls = warnSpy.mock.calls.map(call => call.map(String).join(' '));
        const capturedCalls = warnCalls.filter(line => line.includes('Telegram library TIMEOUT captured'));

        expect(capturedCalls).toHaveLength(1);
        expect(renderedCalls).toHaveLength(1);
        expect(warnCalls).toHaveLength(1);
        expect(Math.max(...[...renderedCalls, ...warnCalls].map(line => line.length))).toBeLessThan(2000);
    });

    test('ignores already captured logger messages', async () => {
        const { LoggerService, enableTelegramConsoleProxy, errorSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        console.error('Telegram library TIMEOUT captured: Error: TIMEOUT');
        await waitForAsyncConsoleLog();

        const renderedCalls = errorSpy.mock.calls.map(call => call.map(String).join(' '));

        expect(renderedCalls).toHaveLength(1);
        expect(renderedCalls[0]).toContain('Telegram library TIMEOUT captured: Error: TIMEOUT');
    });

    test('deduplicates repeated timeout noise and truncates captured messages', async () => {
        const { LoggerService, enableTelegramConsoleProxy, errorSpy, warnSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        const longTimeout = `TIMEOUT ${'x'.repeat(5000)}`;
        console.error(longTimeout);
        console.error(longTimeout);
        await waitForAsyncConsoleLog();

        const renderedCalls = errorSpy.mock.calls.map(call => call.map(String).join(' '));
        const warnCalls = warnSpy.mock.calls.map(call => call.map(String).join(' '));
        const capturedCalls = warnCalls.filter(line => line.includes('Telegram library TIMEOUT captured'));

        expect(capturedCalls).toHaveLength(1);
        expect(renderedCalls).toHaveLength(2);
        expect(warnCalls).toHaveLength(1);
        expect(capturedCalls[0].length).toBeLessThan(2000);
        expect(capturedCalls[0]).not.toContain('x'.repeat(1000));
    });

    test('captures warn and connection events without feeding its own output back into the proxy', async () => {
        const { LoggerService, enableTelegramConsoleProxy, warnSpy, logSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        console.warn('Error: TIMEOUT');
        console.log('Connection to 149.154.167.91:80/TCPFull complete!');
        await waitForAsyncConsoleLog();

        const warnCalls = warnSpy.mock.calls.map(call => call.map(String).join(' '));
        const logCalls = logSpy.mock.calls.map(call => call.map(String).join(' '));

        expect(warnCalls.filter(line => line.includes('Telegram timeout warning captured'))).toHaveLength(1);
        expect(logCalls.filter(line => line.includes('Telegram connection event captured'))).toHaveLength(1);
        expect(warnCalls).toHaveLength(2);
        expect(logCalls).toHaveLength(2);
    });

    test('restores the console methods that were active when the proxy was enabled', async () => {
        const { enableTelegramConsoleProxy, disableTelegramConsoleProxy } = await importFreshLoggerWithConsoleSpies();
        const enabledError = vi.fn();
        const enabledWarn = vi.fn();
        const enabledLog = vi.fn();

        console.error = enabledError;
        console.warn = enabledWarn;
        console.log = enabledLog;

        enableTelegramConsoleProxy();

        const afterEnableError = console.error;
        expect(afterEnableError).not.toBe(enabledError);

        disableTelegramConsoleProxy();

        expect(console.error).toBe(enabledError);
        expect(console.warn).toBe(enabledWarn);
        expect(console.log).toBe(enabledLog);
    });

    test('captures lowercase network timeout aliases', async () => {
        const { LoggerService, enableTelegramConsoleProxy, warnSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        console.error('socket econnreset');
        await waitForAsyncConsoleLog();

        const warnCalls = warnSpy.mock.calls.map(call => call.map(String).join(' '));
        expect(warnCalls.filter(line => line.includes('Telegram library TIMEOUT captured'))).toHaveLength(1);
    });

    test('suppresses low-frequency GramJS update loop TIMEOUT stderr noise', async () => {
        const { LoggerService, enableTelegramConsoleProxy, errorSpy, logSpy, warnSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        console.error(buildGramJsUpdateLoopTimeout());
        await waitForAsyncConsoleLog();

        const errorCalls = errorSpy.mock.calls.map(call => call.map(String).join(' '));
        const warnCalls = warnSpy.mock.calls.map(call => call.map(String).join(' '));
        const logCalls = logSpy.mock.calls.map(call => call.map(String).join(' '));

        expect(errorCalls).toHaveLength(0);
        expect(warnCalls.filter(line => line.includes('Telegram library TIMEOUT captured'))).toHaveLength(0);
        expect(warnCalls.filter(line => line.includes('Telegram update loop TIMEOUT captured'))).toHaveLength(0);
        expect(logCalls.filter(line => line.includes('Telegram update loop TIMEOUT captured'))).toHaveLength(1);
    });

    test('escalates repeated GramJS update loop TIMEOUT bursts to warn once', async () => {
        const { LoggerService, enableTelegramConsoleProxy, errorSpy, logSpy, warnSpy } = await importFreshLoggerWithConsoleSpies();

        enableTelegramConsoleProxy();
        await LoggerService.getInstance().initialize();

        console.error(buildGramJsUpdateLoopTimeout());
        console.error(buildGramJsUpdateLoopTimeout());
        console.error(buildGramJsUpdateLoopTimeout());
        console.error(buildGramJsUpdateLoopTimeout());
        await waitForAsyncConsoleLog();

        const errorCalls = errorSpy.mock.calls.map(call => call.map(String).join(' '));
        const warnCalls = warnSpy.mock.calls.map(call => call.map(String).join(' '));
        const logCalls = logSpy.mock.calls.map(call => call.map(String).join(' '));

        expect(errorCalls).toHaveLength(0);
        expect(logCalls.filter(line => line.includes('Telegram update loop TIMEOUT captured'))).toHaveLength(1);
        expect(warnCalls.filter(line => line.includes('Telegram update loop TIMEOUT burst captured'))).toHaveLength(1);
        expect(warnCalls.filter(line => line.includes('Telegram library TIMEOUT captured'))).toHaveLength(0);
    });
});
