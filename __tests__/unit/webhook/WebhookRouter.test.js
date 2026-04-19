import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as WebhookRouter from '../../../src/webhook/WebhookRouter.js';
import { queueService } from '../../../src/services/QueueService.js';
import { TaskManager } from '../../../src/processor/TaskManager.js';

vi.mock('../../../src/services/QueueService.js', () => ({
    queueService: {
        verifyWebhookSignature: vi.fn()
    }
}));

vi.mock('../../../src/processor/TaskManager.js', () => ({
    TaskManager: {
        handleDownloadWebhook: vi.fn(),
        handleUploadWebhook: vi.fn(),
        handleMediaBatchWebhook: vi.fn(),
        retryTask: vi.fn()
    }
}));

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        }),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn()
    }
}));

// Mock dynamic imports for config
vi.mock('../../../src/config/index.js', () => ({
    getConfig: vi.fn(() => ({ streamForwarding: { secret: 'test-secret' } })),
    refreshConfiguration: vi.fn(() => ({ success: true }))
}));

// Mock stream transfer service
const mockStreamTransferService = {
    handleIncomingChunk: vi.fn(),
    handleStatusUpdate: vi.fn()
};
vi.mock('../../../src/services/StreamTransferService.js', () => ({
    streamTransferService: mockStreamTransferService
}));

// Mock instance coordinator
const mockInstanceCoordinator = {
    getActiveInstances: vi.fn(),
    instanceId: 'test-instance'
};
vi.mock('../../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

// Mock cache service
const mockCacheService = {
    get: vi.fn()
};
vi.mock('../../../src/services/CacheService.js', () => ({
    cache: mockCacheService
}));

// Mock MediaGroupBuffer
const mockMediaGroupBuffer = {
    handleFlushEvent: vi.fn()
};
vi.mock('../../../src/services/MediaGroupBuffer.js', () => ({
    default: mockMediaGroupBuffer
}));

// Mock fetch
global.fetch = vi.fn();

// Mock console.error
const originalConsoleError = console.error;
beforeEach(() => {
    console.error = vi.fn();
});
afterEach(() => {
    console.error = originalConsoleError;
});

describe('WebhookRouter', () => {
    beforeEach(() => {
        WebhookRouter.setAppReadyState(true);
        vi.clearAllMocks();
        global.appInitializer = { businessModulesRunning: true };
    });

    afterEach(() => {
        WebhookRouter.setAppReadyState(false);
        delete global.appInitializer;
    });

    // Helper to create req and res objects
    const createReqRes = (options = {}) => {
        const chunks = options.body !== undefined ? [Buffer.from(options.body)] : [];
        const req = {
            method: options.method || 'GET',
            url: options.url || '/',
            headers: options.headers || { host: 'localhost' },
            [Symbol.asyncIterator]: async function* () {
                for (const chunk of chunks) {
                    yield chunk;
                }
            }
        };
        const res = {
            writeHead: vi.fn(),
            end: vi.fn()
        };
        return { req, res };
    };

    describe('Health Checks', () => {
        it('should handle /health', async () => {
            const { req, res } = createReqRes({ url: '/health' });
            await WebhookRouter.handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle /healthz', async () => {
            const { req, res } = createReqRes({ url: '/healthz' });
            await WebhookRouter.handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle /ready', async () => {
            const { req, res } = createReqRes({ url: '/ready' });
            await WebhookRouter.handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should return 503 for /ready when app is not ready', async () => {
            WebhookRouter.setAppReadyState(false);
            const { req, res } = createReqRes({ url: '/ready' });
            await WebhookRouter.handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Ready');
        });

        it('should return 503 for /health when business modules are not running', async () => {
            global.appInitializer.businessModulesRunning = false;
            const { req, res } = createReqRes({ url: '/health' });
            await WebhookRouter.handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Service Unavailable: Business Modules Down');
        });

        it('should return 500 when health check throws', async () => {
             // In WebhookRouter, an error thrown inside handleHealthChecks
             // try block is caught and returns 500
             const { req, res } = createReqRes({ url: '/health' });
             res.writeHead.mockImplementationOnce(() => { throw new Error('simulated write error'); });
             await WebhookRouter.handleWebhook(req, res);
             expect(res.writeHead).toHaveBeenCalledWith(500);
             expect(res.end).toHaveBeenCalledWith('Internal Server Error');
        });
    });

    describe('App Ready State', () => {
        it('should return 503 if app is not ready for normal routes', async () => {
            WebhookRouter.setAppReadyState(false);
            const { req, res } = createReqRes({ url: '/webhook', method: 'POST' });
            await WebhookRouter.handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Ready');
        });
    });

    describe('Stream Forwarding', () => {
        it('should handle incoming chunks and default status 200 / success OK', async () => {
            const { req, res } = createReqRes({
                url: '/api/v2/stream/task123',
                method: 'POST'
            });
            // Without statusCode, fallback to 200
            // Without success true, fallback to message or 'Error'
            mockStreamTransferService.handleIncomingChunk.mockResolvedValue({ success: true });

            await WebhookRouter.handleWebhook(req, res);

            expect(mockStreamTransferService.handleIncomingChunk).toHaveBeenCalledWith('task123', req);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle incoming chunks with error and default message', async () => {
            const { req, res } = createReqRes({
                url: '/api/v2/stream/task123',
                method: 'POST'
            });
            mockStreamTransferService.handleIncomingChunk.mockResolvedValue({ success: false });

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('Error');
        });

        it('should handle status updates with default 200/Error', async () => {
            const statusPayload = { status: 'completed' };
            const { req, res } = createReqRes({
                url: '/api/v2/tasks/task123/status',
                method: 'POST',
                body: JSON.stringify(statusPayload),
                headers: { host: 'localhost', 'x-some-header': 'value' }
            });
            mockStreamTransferService.handleStatusUpdate.mockResolvedValue({ success: false });

            await WebhookRouter.handleWebhook(req, res);

            expect(mockStreamTransferService.handleStatusUpdate).toHaveBeenCalledWith('task123', statusPayload, req.headers);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('Error');
        });

        it('should handle manual task retry with valid secret and missing type (default auto)', async () => {
            const { req, res } = createReqRes({
                url: '/api/v2/tasks/task123/retry',
                method: 'POST',
                body: '', // Empty body
                headers: { host: 'localhost', 'x-instance-secret': 'test-secret' }
            });
            TaskManager.retryTask.mockResolvedValue({ success: true });

            await WebhookRouter.handleWebhook(req, res);

            expect(TaskManager.retryTask).toHaveBeenCalledWith('task123', 'auto');
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        });

        it('should reject manual task retry with invalid secret', async () => {
            const { req, res } = createReqRes({
                url: '/api/v2/tasks/task123/retry',
                method: 'POST',
                body: '{}',
                headers: { host: 'localhost', 'x-instance-secret': 'wrong-secret' }
            });

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should handle config refresh', async () => {
            const { req, res } = createReqRes({
                url: '/api/v2/config/refresh',
                method: 'POST'
            });

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ success: true }));
        });
    });

    describe('QStash Webhooks', () => {
        it('should reject requests without signature', async () => {
            const { req, res } = createReqRes({
                url: '/api/webhook',
                method: 'POST',
                body: '{}',
                // Explicitly empty signature
                headers: { host: 'localhost', 'upstash-signature': '' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(false);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should handle invalid signature with empty body', async () => {
            const { req, res } = createReqRes({
                url: '/api/webhook',
                method: 'POST',
                body: '',
                headers: { host: 'localhost', 'upstash-signature': 'invalid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(false);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should handle invalid JSON body', async () => {
            const { req, res } = createReqRes({
                url: '/api/webhook',
                method: 'POST',
                body: '',
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(true);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(400);
            expect(res.end).toHaveBeenCalledWith('Invalid JSON');
        });

        it('should process download webhooks with default final result handling', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(true);
            // Default statusCode and error message for final end check
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false });

            await WebhookRouter.handleWebhook(req, res);

            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('task123');
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('Error');
        });

        it('should process upload webhooks', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/upload',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleUploadWebhook.mockResolvedValue({ success: true, statusCode: 200 });

            await WebhookRouter.handleWebhook(req, res);

            expect(TaskManager.handleUploadWebhook).toHaveBeenCalledWith('task123');
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should process batch webhooks', async () => {
            const payload = { groupId: 'group123', taskIds: ['t1', 't2'] };
            const { req, res } = createReqRes({
                url: '/api/webhook/batch',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleMediaBatchWebhook.mockResolvedValue({ success: true, statusCode: 200 });

            await WebhookRouter.handleWebhook(req, res);

            expect(TaskManager.handleMediaBatchWebhook).toHaveBeenCalledWith('group123', ['t1', 't2']);
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should process system-events flush webhook', async () => {
            const payload = { event: 'media_group_flush', gid: 'group123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/system-events',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(true);

            await WebhookRouter.handleWebhook(req, res);

            expect(mockMediaGroupBuffer.handleFlushEvent).toHaveBeenCalledWith(payload);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should ignore unknown webhook paths', async () => {
            const payload = { test: true };
            const { req, res } = createReqRes({
                url: '/api/webhook/unknown',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });
            queueService.verifyWebhookSignature.mockResolvedValue(true);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });
    });

    describe('Webhook Forwarding', () => {
        it('should forward webhook when 503 Not Leader is returned', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            mockCacheService.get.mockResolvedValue({ instanceId: 'leader-instance' });
            mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
                { id: 'leader-instance', tunnelUrl: 'https://leader.example.com' }
            ]);

            global.fetch.mockResolvedValue({
                ok: true,
                status: 200
            });

            await WebhookRouter.handleWebhook(req, res);

            expect(global.fetch).toHaveBeenCalledWith(
                'https://leader.example.com/api/webhook/download',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'upstash-signature': 'valid-sig',
                        'x-forwarded-by-instance': 'test-instance'
                    }),
                    body: JSON.stringify(payload)
                })
            );
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle leaderUrl resolution failure gracefully (catch cache missing)', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            // To hit line 980-981, resolveWebhookLeaderUrl cache throws something that isn't a normal error with .message
            mockCacheService.get.mockRejectedValueOnce('string error message');

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should fallback for activeInstances empty array', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            mockCacheService.get.mockResolvedValue({ instanceId: 'leader-instance' });
            // Returns null/undefined, defaulting to [] in code
            mockInstanceCoordinator.getActiveInstances.mockResolvedValue(null);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should return 503 Not Leader when lock instanceId is missing', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            mockCacheService.get.mockResolvedValue(null);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should return 503 Not Leader when leader instance url is missing', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            mockCacheService.get.mockResolvedValue({ instanceId: 'leader-instance' });
            mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
                { id: 'leader-instance' } // missing tunnelUrl and url
            ]);

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should return error when forwarding fails with non-2xx', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            mockCacheService.get.mockResolvedValue({ instanceId: 'leader-instance' });
            mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
                { id: 'leader-instance', tunnelUrl: 'https://leader.example.com' }
            ]);

            global.fetch.mockResolvedValue({
                ok: false,
                status: 500,
                text: vi.fn().mockResolvedValue('Forward Error')
            });

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Forward Error');
        });

        it('should not forward if already forwarded', async () => {
            const payload = { taskId: 'task123' };
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify(payload),
                headers: {
                    host: 'localhost',
                    'upstash-signature': 'valid-sig',
                    'x-forwarded-by-instance': 'other-instance'
                }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockResolvedValue({
                success: false,
                statusCode: 503,
                message: 'Not Leader'
            });

            await WebhookRouter.handleWebhook(req, res);

            expect(global.fetch).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });
    });

    describe('Error Handling', () => {
        it('should return 500 when an error occurs during webhook processing', async () => {
            const { req, res } = createReqRes({
                url: '/api/webhook/download',
                method: 'POST',
                body: JSON.stringify({taskId: 'task1'}),
                headers: { host: 'localhost', 'upstash-signature': 'valid-sig' }
            });

            queueService.verifyWebhookSignature.mockResolvedValue(true);
            TaskManager.handleDownloadWebhook.mockRejectedValue(new Error('simulated task error'));

            await WebhookRouter.handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Internal Server Error');
            expect(console.error).toHaveBeenCalled();
        });
    });
});
