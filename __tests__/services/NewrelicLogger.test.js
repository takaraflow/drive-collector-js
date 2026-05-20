import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import util from 'util';
import { NewrelicLogger } from '../../src/services/logger/NewrelicLogger.js';

describe('NewrelicLogger Security Vulnerability Reproduction', () => {
    let logger;
    const licenseKey = 'secure-license-key-1234567890';
    const region = 'US';
    const preservedEnv = {};
    const envKeysToRestore = [
        'APP_VERSION',
        'GIT_SHA',
        'BUILD_TIME',
        'IMAGE_TAG',
        'APP_NAME',
        'NEW_RELIC_APP_NAME',
        'LOG_LEVEL'
    ];

    beforeEach(() => {
        envKeysToRestore.forEach(key => {
            preservedEnv[key] = process.env[key];
        });
        vi.stubGlobal('fetch', vi.fn());
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'debug').mockImplementation(() => {});
        vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
        delete process.env.LOG_LEVEL;

        logger = new NewrelicLogger({
            licenseKey,
            region,
            service: 'test-service'
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        envKeysToRestore.forEach(key => {
            if (preservedEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = preservedEnv[key];
            }
        });
    });

    it('should NOT log the license key substring when batch flush fails', async () => {
        // Mock fetch to fail to trigger the catch block in _flushLogsBatch
        fetch.mockRejectedValue(new Error('Network failure with sensitive info: ' + licenseKey));

        // Add a log to the buffer
        await logger.info('test message');

        // Manually trigger flush to wait for it
        try {
            await logger._flushLogsBatch();
        } catch (e) {
            // ignore
        }

        // Check if console.error was called with the license key
        const consoleErrorCalls = console.error.mock.calls.map(call => util.format(...call));
        const licenseKeyLogged = consoleErrorCalls.some(msg => msg.includes(licenseKey.substring(0, 10)));

        // This expectation will fail before the fix
        expect(licenseKeyLogged).toBe(false);
    });

    it('should NOT log detailed API error text in _sendBatch', async () => {
        fetch.mockResolvedValue({
            ok: false,
            status: 403,
            text: () => Promise.resolve('Forbidden: Invalid Key ' + licenseKey)
        });

        await logger.info('test message');
        try {
            await logger._flushLogsBatch();
        } catch (e) {
            // ignore
        }

        const consoleErrorCalls = console.error.mock.calls.map(call => util.format(...call));
        const sensitiveInfoLogged = consoleErrorCalls.some(msg => msg.includes(licenseKey));

        expect(sensitiveInfoLogged).toBe(false);
    });

    it('should NOT log detailed error message in process.stderr.write', async () => {
        const sensitiveErrorMessage = 'Error containing ' + licenseKey;
        fetch.mockRejectedValue(new Error(sensitiveErrorMessage));

        await logger.info('test message');
        try {
            await logger._flushLogsBatch();
        } catch (e) {
            // ignore
        }

        const stderrCalls = process.stderr.write.mock.calls.map(call => util.format(...call));
        const sensitiveInfoLogged = stderrCalls.some(msg => msg.includes(licenseKey));

        expect(sensitiveInfoLogged).toBe(false);
    });

    it('should include active OpenTelemetry trace correlation fields', async () => {
        vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
            spanContext: () => ({
                traceId: '1234567890abcdef1234567890abcdef',
                spanId: '1234567890abcdef'
            })
        });

        const payload = logger._buildPayload('info', 'correlated message', {}, {}, 'instance-1');

        expect(payload['trace.id']).toBe('1234567890abcdef1234567890abcdef');
        expect(payload['span.id']).toBe('1234567890abcdef');
    });

    it('should emit standard New Relic severity and service name attributes', async () => {
        const payload = logger._buildPayload('error', 'failed message', {}, {}, 'instance-1');

        expect(payload.level).toBe('error');
        expect(payload.severity).toBe('ERROR');
        expect(payload['service.name']).toBe('test-service');
    });

    it('should expose Error diagnostics as top-level searchable fields', async () => {
        const error = new Error('fatal rejection');
        error.stack = 'Error: fatal rejection\n    at worker';
        error.code = 'FATAL_REJECTION';

        const payload = logger._buildPayload('error', 'FATAL: Unhandled Rejection', { error }, {}, 'instance-1');

        expect(payload.error_name).toBe('Error');
        expect(payload.error_message).toBe('fatal rejection');
        expect(payload.error_code).toBe('FATAL_REJECTION');
        expect(payload.error_stack).toContain('fatal rejection');
    });

    it('should redact sensitive values from searchable top-level error fields and details', async () => {
        const error = new Error('rclone failed :mega,user="user@example.com",pass="secret-pass":');
        error.stack = 'Error: token={"access_token":"access-secret","refresh_token":"refresh-secret"}';

        const payload = logger._buildPayload('error', 'upload failed pass="message-secret"', { error }, {}, 'instance-1');
        const serializedPayload = JSON.stringify(payload);

        expect(payload.message).toContain('pass="[REDACTED]"');
        expect(payload.error_message).toContain('pass="[REDACTED]"');
        expect(payload.error_stack).toContain('token=[REDACTED]');
        expect(payload.attributes.details).toContain('pass=\\"[REDACTED]\\"');
        expect(serializedPayload).not.toContain('user@example.com');
        expect(serializedPayload).not.toContain('secret-pass');
        expect(serializedPayload).not.toContain('message-secret');
        expect(serializedPayload).not.toContain('access-secret');
        expect(serializedPayload).not.toContain('refresh-secret');
    });

    it('should expose directly logged Error diagnostics as top-level searchable fields', async () => {
        const error = new Error('direct failure');
        error.stack = 'Error: direct failure\n    at direct';
        error.code = 'DIRECT_FAILURE';

        const payload = logger._buildPayload('error', 'direct error', error, {}, 'instance-1');

        expect(payload.error_name).toBe('Error');
        expect(payload.error_message).toBe('direct failure');
        expect(payload.error_code).toBe('DIRECT_FAILURE');
        expect(payload.error_stack).toContain('direct failure');
    });

    it('should expose structured fatal context diagnostics as top-level searchable fields', async () => {
        const payload = logger._buildPayload('error', 'Shutdown reason', {
            fatal_error_name: 'StringRejection',
            fatal_error_message: 'worker rejected',
            fatal_error_stack: 'StringRejection: worker rejected',
            fatal_error_code: 'WORKER_REJECTED'
        }, {}, 'instance-1');

        expect(payload.error_name).toBe('StringRejection');
        expect(payload.error_message).toBe('worker rejected');
        expect(payload.error_code).toBe('WORKER_REJECTED');
        expect(payload.error_stack).toBe('StringRejection: worker rejected');
    });

    it('should expose rclone error object diagnostics as searchable New Relic fields', async () => {
        const error = new Error('ERROR | movie.mp4 | Failed to copy | quota exceeded');

        const payload = logger._buildPayload('error', 'Rclone Batch Error', {
            error,
            rcloneExitCode: 1,
            retryable: false
        }, { module: 'RcloneService' }, 'instance-1');

        expect(payload.error_name).toBe('Error');
        expect(payload.error_message).toContain('Failed to copy');
        expect(payload.error_message).toContain('quota exceeded');
        expect(payload.error_message).not.toContain('pass=');
        expect(payload.attributes.details).toContain('rcloneExitCode');
    });

    it('should attach build identity fields to log payloads', async () => {
        process.env.APP_VERSION = '9.9.9';
        process.env.GIT_SHA = 'abcdef1234567890';
        process.env.BUILD_TIME = '2026-05-18T00:00:00.000Z';
        process.env.IMAGE_TAG = 'repo/app:sha-abcdef1';

        const buildLogger = new NewrelicLogger({
            licenseKey,
            region,
            service: 'test-service'
        });
        await buildLogger.initialize();

        const payload = buildLogger._buildPayload('info', 'release visible', {}, {}, 'instance-1');

        expect(payload.version).toBe('9.9.9');
        expect(payload.git_sha).toBe('abcdef1234567890');
        expect(payload.git_short_sha).toBe('abcdef123456');
        expect(payload.build_time).toBe('2026-05-18T00:00:00.000Z');
        expect(payload.image_tag).toBe('repo/app:sha-abcdef1');
        expect(payload.release_id).toBe('9.9.9+abcdef123456');
    });

    it('should use the build identity service name when logger service is not overridden', async () => {
        process.env.APP_NAME = 'drive-collector-prod';

        const buildLogger = new NewrelicLogger({
            licenseKey,
            region
        });
        await buildLogger.initialize();

        const payload = buildLogger._buildPayload('info', 'service visible', {}, {}, 'instance-1');

        expect(payload['service.name']).toBe('drive-collector-prod');
    });

    it('should only print New Relic batch success in debug log level', async () => {
        fetch.mockResolvedValue({ ok: true, status: 202 });

        process.env.LOG_LEVEL = 'info';
        await logger.info('test message');
        await logger._flushLogsBatch();
        expect(console.debug).not.toHaveBeenCalled();

        process.env.LOG_LEVEL = 'debug';
        await logger.info('debug-visible message');
        await logger._flushLogsBatch();
        expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('Log batch sent'));
    });

    it('should wait for an in-flight batch when flush is requested', async () => {
        let resolveFetch;
        const fetchPromise = new Promise(resolve => {
            resolveFetch = resolve;
        });
        fetch.mockReturnValue(fetchPromise);

        await logger.info('slow batch');
        const activeFlush = logger._flushLogsBatch();

        let flushResolved = false;
        const flushPromise = logger.flush().then(() => {
            flushResolved = true;
        });

        await Promise.resolve();
        expect(flushResolved).toBe(false);

        resolveFetch({ ok: true, status: 202 });
        await activeFlush;
        await flushPromise;

        expect(flushResolved).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should drain logs queued while a batch is already flushing', async () => {
        let resolveFirstFetch;
        const firstFetchPromise = new Promise(resolve => {
            resolveFirstFetch = resolve;
        });
        fetch
            .mockReturnValueOnce(firstFetchPromise)
            .mockResolvedValue({ ok: true, status: 202 });

        await logger.info('first batch');
        const firstFlush = logger._flushLogsBatch();

        await logger.info('second batch');
        const flushPromise = logger.flush();

        resolveFirstFetch({ ok: true, status: 202 });
        await firstFlush;
        await flushPromise;

        expect(fetch).toHaveBeenCalledTimes(2);

        const secondRequestBody = JSON.parse(fetch.mock.calls[1][1].body);
        expect(secondRequestBody[0].logs).toHaveLength(1);
        expect(secondRequestBody[0].logs[0].message).toBe('second batch');
    });

    it('should wait for in-flight New Relic delivery before disconnecting', async () => {
        let resolveFetch;
        const fetchPromise = new Promise(resolve => {
            resolveFetch = resolve;
        });
        fetch.mockReturnValue(fetchPromise);

        await logger.connect();
        await logger.info('shutdown batch');
        const activeFlush = logger._flushLogsBatch();

        let disconnectResolved = false;
        const disconnectPromise = logger.disconnect().then(() => {
            disconnectResolved = true;
        });

        await Promise.resolve();
        expect(disconnectResolved).toBe(false);
        expect(logger.connected).toBe(true);

        resolveFetch({ ok: true, status: 202 });
        await activeFlush;
        await disconnectPromise;

        expect(disconnectResolved).toBe(true);
        expect(logger.connected).toBe(false);
    });
});
