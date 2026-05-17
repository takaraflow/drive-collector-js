import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import util from 'util';
import { NewrelicLogger } from '../../src/services/logger/NewrelicLogger.js';

describe('NewrelicLogger Security Vulnerability Reproduction', () => {
    let logger;
    const licenseKey = 'secure-license-key-1234567890';
    const region = 'US';
    const originalLogLevel = process.env.LOG_LEVEL;

    beforeEach(() => {
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
        if (originalLogLevel === undefined) {
            delete process.env.LOG_LEVEL;
        } else {
            process.env.LOG_LEVEL = originalLogLevel;
        }
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
});
