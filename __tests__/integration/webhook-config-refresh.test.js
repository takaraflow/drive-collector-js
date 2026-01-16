import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { handleQStashWebhook } from '../../index.js';

// Mock dependencies
vi.mock('../../src/config/index.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        refreshConfiguration: vi.fn().mockResolvedValue({ success: true, message: 'Configuration refresh completed' }),
        validateConfig: vi.fn().mockReturnValue(true),
        getConfig: vi.fn().mockReturnValue({
             port: 0, // 0 for random port
             http2: { enabled: false }
        })
    };
});

// Mock services that might be imported by handleQStashWebhook
vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('../../src/processor/TaskManager.js', () => ({
    TaskManager: {
        handleDownloadWebhook: vi.fn(),
        handleUploadWebhook: vi.fn(),
        handleMediaBatchWebhook: vi.fn()
    }
}));

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        }),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

// Mock app ready state
vi.mock('../../index.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        // We need to keep handleQStashWebhook logic but mock internal state if needed
        // However, handleQStashWebhook is exported and we are testing it directly.
        // The issue is appReady state. In index.js it's a module level variable.
        // We can't easily change it without an export.
        // Fortunately index.js exports setAppReadyState.
    };
});


describe('Webhook Configuration Refresh Integration', () => {
    let server;
    let baseUrl;
    let refreshConfigurationMock;

    beforeEach(async () => {
        // Reset mocks
        vi.clearAllMocks();
        
        // Get mocked function
        const configModule = await import('../../src/config/index.js');
        refreshConfigurationMock = configModule.refreshConfiguration;

        // Set app ready
        const indexModule = await import('../../index.js');
        indexModule.setAppReadyState(true);

        // Start a real HTTP server using the handler
        server = http.createServer(handleQStashWebhook);
        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
    });

    afterEach(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('should trigger config refresh on POST /api/v2/config/refresh', async () => {
        const response = await fetch(`${baseUrl}/api/v2/config/refresh`, {
            method: 'POST'
        });

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            message: 'Configuration refresh completed'
        });
        expect(refreshConfigurationMock).toHaveBeenCalledTimes(1);
    });

    test('should handle refresh failure', async () => {
        // Mock failure
        refreshConfigurationMock.mockResolvedValueOnce({
            success: false,
            message: 'Refresh failed: some error'
        });

        const response = await fetch(`${baseUrl}/api/v2/config/refresh`, {
            method: 'POST'
        });

        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body).toEqual({
            success: false,
            message: 'Refresh failed: some error'
        });
        expect(refreshConfigurationMock).toHaveBeenCalledTimes(1);
    });

    test('should ignore GET requests to refresh endpoint', async () => {
        // Based on implementation: 
        // if (path === '/api/v2/config/refresh' && req.method === 'POST')
        // So GET should fall through to other logic or 404/Unknown webhook
        
        // Note: The current implementation falls through to QStash signature check if not matched.
        // Since we didn't provide signature header, it should return 401 Unauthorized
        // or 503 if not ready (but we set ready=true)
        
        const response = await fetch(`${baseUrl}/api/v2/config/refresh`, {
            method: 'GET'
        });

        expect(refreshConfigurationMock).not.toHaveBeenCalled();
        // Should fall through to QStash check which requires signature
        expect(response.status).toBe(401); 
    });
});
