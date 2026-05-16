import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/services/logger/AxiomLogger.js', () => ({
    AxiomLogger: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
        client: null,
        getProviderName: () => 'AxiomLogger'
    }))
}));

vi.mock('../../../src/services/logger/NewrelicLogger.js', () => ({
    NewrelicLogger: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
        licenseKey: null,
        getProviderName: () => 'NewrelicLogger'
    }))
}));

vi.mock('../../../src/services/logger/ConsoleLogger.js', () => ({
    ConsoleLogger: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
        getProviderName: () => 'ConsoleLogger',
        getConnectionInfo: () => ({ provider: 'ConsoleLogger', connected: true })
    }))
}));

const {
    LoggerService,
    defaultLogLevelForEnv,
    getConfiguredLogLevel,
    normalizeLogLevel,
    shouldSendLogLevel
} = await import('../../../src/services/logger/LoggerService.js');

describe('LoggerService log level gate', () => {
    const originalEnv = {
        LOG_LEVEL: process.env.LOG_LEVEL,
        NODE_ENV: process.env.NODE_ENV
    };

    beforeEach(() => {
        delete process.env.LOG_LEVEL;
        process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
        if (originalEnv.LOG_LEVEL === undefined) {
            delete process.env.LOG_LEVEL;
        } else {
            process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
        }

        if (originalEnv.NODE_ENV === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalEnv.NODE_ENV;
        }
    });

    test('defaults to info in production and debug outside production', () => {
        expect(defaultLogLevelForEnv('prod')).toBe('info');
        expect(defaultLogLevelForEnv('production')).toBe('info');
        expect(defaultLogLevelForEnv('dev')).toBe('debug');
        expect(defaultLogLevelForEnv('test')).toBe('debug');
    });

    test('normalizes supported levels and warning alias', () => {
        expect(normalizeLogLevel(' WARN ')).toBe('warn');
        expect(normalizeLogLevel('warning')).toBe('warn');
        expect(normalizeLogLevel('debug')).toBe('debug');
        expect(normalizeLogLevel('verbose')).toBeNull();
        expect(normalizeLogLevel(undefined)).toBeNull();
    });

    test('reads configured level from process env with default fallback', () => {
        process.env.NODE_ENV = 'production';
        expect(getConfiguredLogLevel()).toBe('info');

        process.env.LOG_LEVEL = 'error';
        expect(getConfiguredLogLevel()).toBe('error');

        process.env.LOG_LEVEL = 'invalid';
        expect(getConfiguredLogLevel()).toBe('info');
    });

    test('allows only levels at or above configured severity', () => {
        process.env.LOG_LEVEL = 'warn';

        expect(shouldSendLogLevel('error')).toBe(true);
        expect(shouldSendLogLevel('warn')).toBe(true);
        expect(shouldSendLogLevel('info')).toBe(false);
        expect(shouldSendLogLevel('debug')).toBe(false);
    });

    test('gates providers before dispatching logs', async () => {
        process.env.LOG_LEVEL = 'warn';

        const logger = new LoggerService();
        const provider = {
            info: vi.fn().mockResolvedValue(undefined),
            warn: vi.fn().mockResolvedValue(undefined),
            error: vi.fn().mockResolvedValue(undefined),
            debug: vi.fn().mockResolvedValue(undefined),
            getProviderName: () => 'test-provider'
        };
        logger.activeLoggers = [provider];
        logger.isInitialized = true;

        await logger.debug('hidden debug');
        await logger.info('hidden info');
        await logger.warn('visible warn');

        expect(provider.debug).not.toHaveBeenCalled();
        expect(provider.info).not.toHaveBeenCalled();
        expect(provider.warn).toHaveBeenCalledTimes(1);
    });
});
