import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleWebhook, setAppReadyState } from '../../../src/webhook/WebhookRouter.js';

vi.mock('../../../src/services/logger/index.js', () => {
    return {
        logger: {
            withModule: vi.fn().mockReturnValue({
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn()
            }),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        }
    };
});

vi.mock('../../../src/services/QueueService.js', () => {
    return {
        queueService: {
            verifyWebhookSignature: vi.fn()
        }
    };
});

vi.mock('../../../src/processor/TaskManager.js', () => {
    return {
        TaskManager: {
            handleDownloadWebhook: vi.fn(),
            handleUploadWebhook: vi.fn(),
            handleMediaBatchWebhook: vi.fn(),
            retryTask: vi.fn()
        }
    };
});

// Mock dynamic imports
vi.mock('../../../src/services/StreamTransferService.js', () => {
    return {
        streamTransferService: {
            handleIncomingChunk: vi.fn(),
            handleStatusUpdate: vi.fn()
        }
    };
});

vi.mock('../../../src/config/index.js', () => {
    return {
        getConfig: vi.fn(),
        refreshConfiguration: vi.fn()
    };
});

vi.mock('../../../src/services/MediaGroupBuffer.js', () => {
    return {
        default: {
            handleFlushEvent: vi.fn()
        }
    };
});

vi.mock('../../../src/services/CacheService.js', () => {
    return {
        cache: {
            get: vi.fn()
        }
    };
});

vi.mock('../../../src/services/InstanceCoordinator.js', () => {
    return {
        instanceCoordinator: {
            instanceId: 'test-instance',
            getActiveInstances: vi.fn()
        }
    };
});

describe('WebhookRouter', () => {
    let req;
    let res;

    beforeEach(async () => {
        setAppReadyState(true);
        global.appInitializer = { businessModulesRunning: true };

        req = {
            method: 'POST',
            headers: {
                host: 'localhost',
                'upstash-signature': 'valid-signature'
            },
            url: '/',
            [Symbol.asyncIterator]: async function* () {
                yield Buffer.from('{}');
            }
        };

        res = {
            writeHead: vi.fn(),
            end: vi.fn()
        };

        // Default mocks
        const { queueService } = await import('../../../src/services/QueueService.js');
        queueService.verifyWebhookSignature.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('handleHealthChecks', () => {
        it('should return 200 for /health', async () => {
            req.method = 'GET';
            req.url = '/health';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should return 200 for /healthz', async () => {
            req.method = 'GET';
            req.url = '/healthz';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should return 200 for /ready when app is ready', async () => {
            req.method = 'GET';
            req.url = '/ready';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should return 503 for /ready when app is not ready', async () => {
            req.method = 'GET';
            req.url = '/ready';
            setAppReadyState(false);
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Ready');
        });

        it('should return 503 when business modules are down', async () => {
            req.method = 'GET';
            req.url = '/health';
            global.appInitializer = { businessModulesRunning: false };
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Service Unavailable: Business Modules Down');
        });

        it('should handle HEAD request for /health', async () => {
            req.method = 'HEAD';
            req.url = '/health';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('');
        });

        it('should catch errors during health check processing', async () => {
            req.method = 'GET';
            req.url = '/health';
            res.writeHead.mockImplementationOnce(() => {
                throw new Error('Simulated error inside try block');
            });
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Internal Server Error');
        });
    });

    describe('handleStreamForwarding', () => {
        it('should handle /api/v2/stream/:taskId', async () => {
            req.url = '/api/v2/stream/123';
            req.method = 'POST';
            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.handleIncomingChunk.mockResolvedValue({ success: true, statusCode: 200 });

            await handleWebhook(req, res);

            expect(streamTransferService.handleIncomingChunk).toHaveBeenCalledWith('123', req);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle /api/v2/tasks/:taskId/status', async () => {
            req.url = '/api/v2/tasks/123/status';
            req.method = 'POST';
            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.handleStatusUpdate.mockResolvedValue({ success: true, statusCode: 200 });

            await handleWebhook(req, res);

            expect(streamTransferService.handleStatusUpdate).toHaveBeenCalledWith('123', {}, req.headers);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle /api/v2/tasks/:taskId/retry with valid secret', async () => {
            req.url = '/api/v2/tasks/123/retry';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.retryTask.mockResolvedValue({ success: true, statusCode: 200 });

            await handleWebhook(req, res);

            expect(TaskManager.retryTask).toHaveBeenCalledWith('123', 'auto');
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ success: true, statusCode: 200 }));
        });

        it('should reject /api/v2/tasks/:taskId/retry with invalid secret', async () => {
            req.url = '/api/v2/tasks/123/retry';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'wrong-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should handle /api/v2/config/refresh', async () => {
            req.url = '/api/v2/config/refresh';
            req.method = 'POST';

            const { refreshConfiguration } = await import('../../../src/config/index.js');
            refreshConfiguration.mockResolvedValue({ success: true });

            await handleWebhook(req, res);

            expect(refreshConfiguration).toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ success: true }));
        });
    });

    describe('processWebhookData and general flows', () => {
        it('should return 401 if signature is missing', async () => {
            req.headers['upstash-signature'] = undefined;
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should return 401 if signature verification fails', async () => {
            const { queueService } = await import('../../../src/services/QueueService.js');
            queueService.verifyWebhookSignature.mockResolvedValue(false);
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should return 400 for invalid JSON body', async () => {
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from('invalid-json');
            };
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(400);
            expect(res.end).toHaveBeenCalledWith('Invalid JSON');
        });

        it('should handle /download webhook', async () => {
            req.url = '/webhook/download';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-1' }));
            };
            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: true, statusCode: 200 });
            await handleWebhook(req, res);
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('task-1');
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should handle /upload webhook', async () => {
            req.url = '/webhook/upload';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-2' }));
            };
            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleUploadWebhook.mockResolvedValue({ success: true, statusCode: 200 });
            await handleWebhook(req, res);
            expect(TaskManager.handleUploadWebhook).toHaveBeenCalledWith('task-2');
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should handle /batch webhook', async () => {
            req.url = '/webhook/batch';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ groupId: 'group-1', taskIds: ['t1', 't2'] }));
            };
            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleMediaBatchWebhook.mockResolvedValue({ success: true, statusCode: 200 });
            await handleWebhook(req, res);
            expect(TaskManager.handleMediaBatchWebhook).toHaveBeenCalledWith('group-1', ['t1', 't2']);
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should handle /system-events webhook', async () => {
            req.url = '/webhook/system-events';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ event: 'media_group_flush', gid: 'group-1' }));
            };
            const { default: mediaGroupBuffer } = await import('../../../src/services/MediaGroupBuffer.js');
            await handleWebhook(req, res);
            expect(mediaGroupBuffer.handleFlushEvent).toHaveBeenCalledWith(expect.objectContaining({ gid: 'group-1' }));
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should return 200 for unknown webhook path but log warning', async () => {
            req.url = '/webhook/unknown';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should forward webhook to leader if response is 503 Not Leader', async () => {
            req.url = '/webhook/download';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-3' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            const { cache } = await import('../../../src/services/CacheService.js');
            cache.get.mockResolvedValue({ instanceId: 'leader-instance' });

            const { instanceCoordinator } = await import('../../../src/services/InstanceCoordinator.js');
            instanceCoordinator.getActiveInstances.mockResolvedValue([{ id: 'leader-instance', url: 'http://leader.local' }]);

            global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

            await handleWebhook(req, res);

            expect(global.fetch).toHaveBeenCalledWith(
                'http://leader.local/webhook/download',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'x-forwarded-by-instance': 'test-instance'
                    })
                })
            );
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle 500 error from forwarding to leader', async () => {
            req.url = '/webhook/download';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-4' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            const { cache } = await import('../../../src/services/CacheService.js');
            cache.get.mockResolvedValue({ instanceId: 'leader-instance' });

            const { instanceCoordinator } = await import('../../../src/services/InstanceCoordinator.js');
            instanceCoordinator.getActiveInstances.mockResolvedValue([{ id: 'leader-instance', url: 'http://leader.local' }]);

            global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Upstream Error') });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Upstream Error');
        });

        it('should handle AppReady state not ready within general handleWebhook flow', async () => {
            setAppReadyState(false);
            req.url = '/webhook/download';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Ready');
        });
    });
});
