import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => {
    const axiomInitialize = vi.fn().mockResolvedValue(undefined);
    const axiomConnect = vi.fn().mockResolvedValue(undefined);
    const axiomFactory = vi.fn().mockImplementation(function () {
        return {
            initialize: axiomInitialize,
            connect: axiomConnect,
            client: null,
            getProviderName: () => 'AxiomLogger'
        };
    });

    const newrelicInitialize = vi.fn().mockResolvedValue(undefined);
    const newrelicConnect = vi.fn().mockResolvedValue(undefined);
    const newrelicInfo = vi.fn().mockResolvedValue(undefined);
    const newrelicDisconnect = vi.fn().mockResolvedValue(undefined);
    const newrelicFlush = vi.fn().mockResolvedValue(undefined);
    let newrelicLicenseKey = null;
    const newrelicFactory = vi.fn().mockImplementation(function () {
        return {
            initialize: newrelicInitialize,
            connect: newrelicConnect,
            licenseKey: newrelicLicenseKey,
            info: newrelicInfo,
            disconnect: newrelicDisconnect,
            flush: newrelicFlush,
            getProviderName: () => 'NewrelicLogger',
            getConnectionInfo: () => ({ provider: 'NewrelicLogger', connected: Boolean(newrelicLicenseKey) })
        };
    });

    const consoleInitialize = vi.fn().mockResolvedValue(undefined);
    const consoleInfo = vi.fn().mockResolvedValue(undefined);
    const consoleWarn = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.fn().mockResolvedValue(undefined);
    const consoleDebug = vi.fn().mockResolvedValue(undefined);
    const consoleFactory = vi.fn().mockImplementation(function () {
        return {
            initialize: consoleInitialize,
            info: consoleInfo,
            warn: consoleWarn,
            error: consoleError,
            debug: consoleDebug,
            getProviderName: () => 'ConsoleLogger',
            getConnectionInfo: () => ({ provider: 'ConsoleLogger', connected: true })
        };
    });

    return {
        axiomInitialize,
        axiomConnect,
        axiomFactory,
        newrelicInitialize,
        newrelicConnect,
        newrelicInfo,
        newrelicDisconnect,
        newrelicFlush,
        newrelicFactory,
        consoleInitialize,
        consoleInfo,
        consoleWarn,
        consoleError,
        consoleDebug,
        consoleFactory,
        setNewrelicLicenseKey(value) {
            newrelicLicenseKey = value;
        }
    };
});

vi.mock('../../../src/services/logger/AxiomLogger.js', () => ({
    AxiomLogger: loggerMocks.axiomFactory
}));

vi.mock('../../../src/services/logger/NewrelicLogger.js', () => ({
    NewrelicLogger: loggerMocks.newrelicFactory
}));

vi.mock('../../../src/services/logger/ConsoleLogger.js', () => ({
    ConsoleLogger: loggerMocks.consoleFactory
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
        vi.clearAllMocks();
        loggerMocks.setNewrelicLicenseKey(null);
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

    test('keeps module contexts isolated between scoped loggers', async () => {
        const logger = new LoggerService();
        const provider = {
            info: vi.fn().mockResolvedValue(undefined),
            getProviderName: () => 'test-provider'
        };
        logger.activeLoggers = [provider];
        logger.isInitialized = true;

        const d1Log = logger.withModule('D1');
        const queueLog = logger.withModule('QueueService');

        await d1Log.info('d1 ready');
        await queueLog.info('queue ready');
        await d1Log.info('d1 query');

        expect(provider.info).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            {},
            expect.objectContaining({ module: 'D1' })
        );
        expect(provider.info).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            {},
            expect.objectContaining({ module: 'QueueService' })
        );
        expect(provider.info).toHaveBeenNthCalledWith(
            3,
            expect.any(String),
            {},
            expect.objectContaining({ module: 'D1' })
        );
    });

    test('returns a stable scoped logger for the same module name', () => {
        const logger = new LoggerService();

        expect(logger.withModule('StreamTransferService')).toBe(logger.withModule('StreamTransferService'));
        expect(logger.withModule('StreamTransferService')).not.toBe(logger.withModule('D1'));
    });

    test('does not leak scoped context into the base logger', async () => {
        const logger = new LoggerService();
        const provider = {
            info: vi.fn().mockResolvedValue(undefined),
            getProviderName: () => 'test-provider'
        };
        logger.activeLoggers = [provider];
        logger.isInitialized = true;

        await logger.withContext({ perf: true }).info('timed operation');
        await logger.info('plain operation');

        expect(provider.info).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            {},
            expect.objectContaining({ perf: true })
        );
        expect(provider.info.mock.calls[1][2]).not.toHaveProperty('perf');
        expect(provider.info.mock.calls[1][2]).not.toHaveProperty('module');
    });

    test('merges chained scoped context and lets per-call context override it', async () => {
        const logger = new LoggerService();
        const provider = {
            info: vi.fn().mockResolvedValue(undefined),
            getProviderName: () => 'test-provider'
        };
        logger.activeLoggers = [provider];
        logger.isInitialized = true;

        const scopedLog = logger
            .withModule('Dispatcher')
            .withContext({ perf: true, requestId: null });

        await scopedLog.info('event', {}, { module: 'MessageHandler', requestId: 'req-1' });

        expect(provider.info).toHaveBeenCalledWith(
            expect.any(String),
            {},
            expect.objectContaining({
                module: 'MessageHandler',
                perf: true,
                requestId: 'req-1',
                env: 'test',
                instanceId: expect.any(String)
            })
        );
    });

    test('redacts sensitive values before dispatching to providers', async () => {
        const logger = new LoggerService();
        const provider = {
            error: vi.fn().mockResolvedValue(undefined),
            getProviderName: () => 'test-provider'
        };
        logger.activeLoggers = [provider];
        logger.isInitialized = true;

        await logger.error(
            'upload failed pass="message-secret"',
            {
                stderr: 'rclone :mega,user="user@example.com",pass="secret-pass": failed',
                token: 'plain-token'
            },
            { module: 'RcloneService', accessToken: 'context-token' }
        );

        const [message, data, context] = provider.error.mock.calls[0];
        const serialized = JSON.stringify({ message, data, context });

        expect(message).toContain('pass="[REDACTED]"');
        expect(data.stderr).toContain('user="[REDACTED]"');
        expect(data.stderr).toContain('pass="[REDACTED]"');
        expect(data.token).toBe('[REDACTED]');
        expect(context.accessToken).toBe('[REDACTED]');
        expect(serialized).not.toContain('message-secret');
        expect(serialized).not.toContain('user@example.com');
        expect(serialized).not.toContain('secret-pass');
        expect(serialized).not.toContain('plain-token');
        expect(serialized).not.toContain('context-token');
    });

    test('reload marks provider lifecycle initialized before dispatching startup logs', async () => {
        loggerMocks.setNewrelicLicenseKey('license');
        const logger = new LoggerService();

        await logger.reload();
        await logger.info('startup ready');

        expect(loggerMocks.newrelicFactory).toHaveBeenCalledTimes(1);
        expect(loggerMocks.consoleFactory).toHaveBeenCalledTimes(1);
        expect(loggerMocks.newrelicInfo).toHaveBeenCalledWith(
            expect.stringContaining('startup ready'),
            {},
            expect.objectContaining({ env: 'test', instanceId: expect.any(String) })
        );
        expect(loggerMocks.consoleInfo).toHaveBeenCalledWith(
            expect.stringContaining('startup ready'),
            {},
            expect.objectContaining({ env: 'test', instanceId: expect.any(String) })
        );
    });

    test('coalesces concurrent lazy initialization before dispatching logs', async () => {
        loggerMocks.setNewrelicLicenseKey('license');
        const logger = new LoggerService();

        await Promise.all([
            logger.info('first boot log'),
            logger.info('second boot log')
        ]);

        expect(loggerMocks.newrelicFactory).toHaveBeenCalledTimes(1);
        expect(loggerMocks.consoleFactory).toHaveBeenCalledTimes(1);
        expect(loggerMocks.newrelicInfo).toHaveBeenCalledTimes(2);
        expect(loggerMocks.consoleInfo).toHaveBeenCalledTimes(2);
    });
});
