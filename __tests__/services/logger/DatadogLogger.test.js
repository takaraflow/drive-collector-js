import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { DatadogLogger } from '../../../src/services/logger/DatadogLogger.js';

describe('DatadogLogger', () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = process.env;
        process.env = { ...originalEnv };
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.unstubAllGlobals();
    });

    describe('constructor', () => {
        test('should initialize with provided options', () => {
            const logger = new DatadogLogger({
                apiKey: 'test-api-key',
                site: 'test.datadoghq.eu',
                service: 'test-service'
            });

            expect(logger.apiKey).toBe('test-api-key');
            expect(logger.site).toBe('test.datadoghq.eu');
            expect(logger.service).toBe('test-service');
            expect(logger.version).toBe('unknown');
        });

        test('should fallback to environment variables', () => {
            process.env.DATADOG_API_KEY = 'env-api-key';
            process.env.DATADOG_SITE = 'env.datadoghq.com';

            const logger = new DatadogLogger();

            expect(logger.apiKey).toBe('env-api-key');
            expect(logger.site).toBe('env.datadoghq.com');
            expect(logger.service).toBe('drive-collector');
        });

        test('should use default values if not provided', () => {
            const logger = new DatadogLogger();

            expect(logger.apiKey).toBeUndefined();
            expect(logger.site).toBe('datadoghq.com');
            expect(logger.service).toBe('drive-collector');
        });
    });

    describe('initialize', () => {
        test('should set isInitialized to true', async () => {
            const logger = new DatadogLogger({ apiKey: 'test-key' });

            await logger.initialize();

            expect(logger.isInitialized).toBe(true);
        });

        test('should warn if apiKey is not configured', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const logger = new DatadogLogger();

            await logger.initialize();

            expect(warnSpy).toHaveBeenCalledWith('Datadog API key not configured');
            warnSpy.mockRestore();
        });

        test('should not warn if apiKey is configured', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const logger = new DatadogLogger({ apiKey: 'test-key' });

            await logger.initialize();

            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        test('should not initialize twice', async () => {
            const logger = new DatadogLogger({ apiKey: 'test-key' });
            logger.isInitialized = true;

            await logger.initialize();

            expect(logger.isInitialized).toBe(true);
        });
    });

    describe('_connect', () => {
        test('should set connected to false if no apiKey', async () => {
            const logger = new DatadogLogger();

            await logger._connect();

            expect(logger.connected).toBe(false);
        });

        test('should set connected to true if apiKey is present', async () => {
            const logger = new DatadogLogger({ apiKey: 'test-key' });

            await logger._connect();

            expect(logger.connected).toBe(true);
        });
    });

    describe('_sendToDatadog', () => {
        let logger;

        beforeEach(() => {
            logger = new DatadogLogger({ apiKey: 'test-key', site: 'test-site.com' });
        });

        test('should send payload with correct structure and headers', async () => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: true });
            vi.stubGlobal('fetch', fetchMock);

            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now);

            await logger._sendToDatadog('info', 'test message', { foo: 'bar' }, { instanceId: 'inst-1' });

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, options] = fetchMock.mock.calls[0];

            expect(url).toBe('https://http-intake.logs.test-site.com/v1/input/test-key');
            expect(options.method).toBe('POST');
            expect(options.headers['Content-Type']).toBe('application/json');

            const payloadArray = JSON.parse(options.body);
            expect(payloadArray).toBeInstanceOf(Array);
            expect(payloadArray).toHaveLength(1);

            const payload = payloadArray[0];
            expect(payload.ddsource).toBe('node');
            expect(payload.ddtags).toContain('service:drive-collector');
            expect(payload.hostname).toBe('inst-1');
            expect(payload.message).toBe('test message');
            expect(payload.status).toBe('info');
            expect(payload.timestamp).toBe(now * 1000000);
            expect(payload.additional_info).toEqual({ foo: 'bar' });
        });

        test('should throw error if fetch response is not ok', async () => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
            vi.stubGlobal('fetch', fetchMock);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(logger._sendToDatadog('info', 'test message', {}, {}))
                .rejects
                .toThrow('Datadog API error: 500');

            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });

        test('should use default unknown for missing context instanceId', async () => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: true });
            vi.stubGlobal('fetch', fetchMock);

            await logger._sendToDatadog('info', 'test message', {}, {});

            const [, options] = fetchMock.mock.calls[0];
            const payload = JSON.parse(options.body)[0];
            expect(payload.hostname).toBe('unknown');
        });

        test('should catch and rethrow fetch errors', async () => {
            const fetchError = new Error('Network failure');
            const fetchMock = vi.fn().mockRejectedValue(fetchError);
            vi.stubGlobal('fetch', fetchMock);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(logger._sendToDatadog('info', 'test message', {}, {}))
                .rejects
                .toThrow('Network failure');

            expect(errorSpy).toHaveBeenCalledWith('Datadog log failed:', 'Network failure');
            errorSpy.mockRestore();
        });
    });

    describe('log methods', () => {
        let logger;
        let sendSpy;

        beforeEach(() => {
            logger = new DatadogLogger({ apiKey: 'test-key' });
            sendSpy = vi.spyOn(logger, '_sendToDatadog').mockResolvedValue();
        });

        test('info should call _sendToDatadog with info level', async () => {
            await logger.info('msg', { a: 1 }, { ctx: 1 });
            expect(sendSpy).toHaveBeenCalledWith('info', 'msg', { a: 1 }, { ctx: 1 });
        });

        test('warn should call _sendToDatadog with warning level', async () => {
            await logger.warn('msg', { a: 1 }, { ctx: 1 });
            expect(sendSpy).toHaveBeenCalledWith('warning', 'msg', { a: 1 }, { ctx: 1 });
        });

        test('error should call _sendToDatadog with error level', async () => {
            await logger.error('msg', { a: 1 }, { ctx: 1 });
            expect(sendSpy).toHaveBeenCalledWith('error', 'msg', { a: 1 }, { ctx: 1 });
        });

        test('debug should call _sendToDatadog with debug level', async () => {
            await logger.debug('msg', { a: 1 }, { ctx: 1 });
            expect(sendSpy).toHaveBeenCalledWith('debug', 'msg', { a: 1 }, { ctx: 1 });
        });

        test('methods should use default empty objects for data and context', async () => {
            await logger.info('msg');
            expect(sendSpy).toHaveBeenCalledWith('info', 'msg', {}, {});
        });
    });
});
