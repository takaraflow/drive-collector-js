import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebhook, setAppReadyState } from '../../../src/webhook/WebhookRouter.js';

describe('WebhookRouter handleHealthChecks', () => {
    beforeEach(() => {
        setAppReadyState(true);
        // Mock global.appInitializer
        global.appInitializer = { businessModulesRunning: true };
    });

    it('should catch errors during health check processing', async () => {
        const req = {
            method: 'GET',
            headers: { host: 'localhost' },
            url: '/health'
        };

        const res = {
            writeHead: vi.fn(),
            end: vi.fn()
        };

        // When the FIRST res.writeHead(200) is called, it throws an error.
        // Then the catch block calls res.writeHead(500), which we shouldn't make throw again!
        res.writeHead.mockImplementationOnce(() => {
            throw new Error('Simulated error inside try block');
        });

        await handleWebhook(req, res);

        // The catch block in handleHealthChecks should catch this
        // and return 500
        expect(res.writeHead).toHaveBeenCalledWith(500);
        expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    });
});
