import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewrelicLogger } from '../../src/services/logger/NewrelicLogger.js';

describe('NewrelicLogger Security Vulnerability Reproduction', () => {
    let logger;
    const licenseKey = 'secure-license-key-1234567890';
    const region = 'US';

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(process.stderr, 'write').mockImplementation(() => {});

        logger = new NewrelicLogger({
            licenseKey,
            region,
            service: 'test-service'
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
        const consoleErrorCalls = console.error.mock.calls.map(call => call.join(' '));
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

        const consoleErrorCalls = console.error.mock.calls.map(call => call.join(' '));
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

        const stderrCalls = process.stderr.write.mock.calls.map(call => call[0]);
        const sensitiveInfoLogged = stderrCalls.some(msg => msg.includes(licenseKey));

        expect(sensitiveInfoLogged).toBe(false);
    });
});
