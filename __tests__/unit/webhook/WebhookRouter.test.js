import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleWebhook, setAppReadyState } from '../../../src/webhook/WebhookRouter.js';

const webhookLog = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
}));

vi.mock('../../../src/services/logger/index.js', () => {
    return {
        logger: {
            withModule: vi.fn().mockReturnValue(webhookLog),
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
            handleStatusUpdate: vi.fn(),
            getTaskProgress: vi.fn(),
            getTaskFullProgress: vi.fn(),
            resumeTask: vi.fn(),
            resetTask: vi.fn()
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

vi.mock('../../../src/services/StateSynchronizer.js', () => {
    return {
        stateSynchronizer: {
            handleSyncEvent: vi.fn()
        }
    };
});

vi.mock('../../../src/services/ConsistentCache.js', () => {
    return {
        consistentCache: {
            handleSyncEvent: vi.fn()
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
        webhookLog.info.mockClear();
        webhookLog.warn.mockClear();
        webhookLog.error.mockClear();
        webhookLog.debug.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete global.appInitializer;
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

        it('should keep liveness healthy when business modules are down', async () => {
            req.method = 'GET';
            req.url = '/health';
            global.appInitializer = { businessModulesRunning: false };
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should return 503 for /ready when business modules are down', async () => {
            req.method = 'GET';
            req.url = '/ready';
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
            req.headers['x-instance-secret'] = 'test-secret';
            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.handleIncomingChunk.mockResolvedValue({ success: true, statusCode: 200 });

            await handleWebhook(req, res);

            expect(streamTransferService.handleIncomingChunk).toHaveBeenCalledWith('123', req);
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        it('should handle /api/v2/stream/:taskId failure', async () => {
            req.url = '/api/v2/stream/123';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';
            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.handleIncomingChunk.mockResolvedValue({ success: false, statusCode: 500, message: 'Stream error' });

            await handleWebhook(req, res);

            expect(streamTransferService.handleIncomingChunk).toHaveBeenCalledWith('123', req);
            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Stream error');
        });

        it('should handle /api/v2/tasks/:taskId/status', async () => {
            req.url = '/api/v2/tasks/123/status';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';
            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
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

            expect(TaskManager.retryTask).toHaveBeenCalledWith('123');
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
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig, refreshConfiguration } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
            refreshConfiguration.mockResolvedValue({ success: true });

            await handleWebhook(req, res);

            expect(refreshConfiguration).toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ success: true }));
        });

        it('should handle state_sync queue webhooks without warning as unknown', async () => {
            req.url = '/api/v2/tasks/state_sync';
            req.method = 'POST';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({
                    type: 'state_change',
                    source: 'peer-instance',
                    userId: 'user-1',
                    stateType: 'tasks',
                    state: { active: 1 }
                }));
            };

            const { stateSynchronizer } = await import('../../../src/services/StateSynchronizer.js');

            await handleWebhook(req, res);

            expect(stateSynchronizer.handleSyncEvent).toHaveBeenCalledWith(expect.objectContaining({
                type: 'state_change',
                userId: 'user-1',
                stateType: 'tasks'
            }));
            expect(webhookLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('未知的 Webhook 路径'));
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should route cache_sync queue webhooks to ConsistentCache without treating them as task webhooks', async () => {
            req.url = '/api/v2/tasks/cache_sync';
            req.method = 'POST';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({
                    type: 'cache_change',
                    action: 'set',
                    key: 'task:user-1',
                    value: { active: 1 },
                    source: 'peer-instance'
                }));
            };

            const { consistentCache } = await import('../../../src/services/ConsistentCache.js');
            const { TaskManager } = await import('../../../src/processor/TaskManager.js');

            await handleWebhook(req, res);

            expect(consistentCache.handleSyncEvent).toHaveBeenCalledWith(expect.objectContaining({
                type: 'cache_change',
                action: 'set',
                key: 'task:user-1'
            }));
            expect(TaskManager.handleDownloadWebhook).not.toHaveBeenCalled();
            expect(TaskManager.handleUploadWebhook).not.toHaveBeenCalled();
            expect(TaskManager.handleMediaBatchWebhook).not.toHaveBeenCalled();
            expect(webhookLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('未知的 Webhook 路径'));
            expect(res.writeHead).toHaveBeenCalledWith(200);
        });

        it('should return 500 when /api/v2/config/refresh fails', async () => {
            req.url = '/api/v2/config/refresh';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig, refreshConfiguration } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
            refreshConfiguration.mockResolvedValue({ success: false });

            await handleWebhook(req, res);

            expect(refreshConfiguration).toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ success: false }));
        });

        it('should handle stream forwarding failure', async () => {
            req.url = '/api/v2/stream/123';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';
            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.handleIncomingChunk.mockResolvedValue({ success: false, statusCode: 500, message: 'Stream Error' });

            await handleWebhook(req, res);

            expect(streamTransferService.handleIncomingChunk).toHaveBeenCalledWith('123', req);
            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Stream Error');
        });

        it('should handle GET /api/v2/stream/:taskId/progress with valid secret', async () => {
            req.url = '/api/v2/stream/task-1/progress';
            req.method = 'GET';
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.getTaskProgress.mockReturnValue(5);

            await handleWebhook(req, res);

            expect(streamTransferService.getTaskProgress).toHaveBeenCalledWith('task-1');
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ lastChunkIndex: 5 }));
        });

        it('should reject stream control routes with invalid secret', async () => {
            req.url = '/api/v2/stream/task-1/progress';
            req.method = 'GET';
            req.headers['x-instance-secret'] = 'wrong-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should reject stream control routes when secret header is missing', async () => {
            req.url = '/api/v2/stream/task-1/full-progress';
            req.method = 'GET';
            delete req.headers['x-instance-secret'];

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should reject stream control routes when configured secret is empty', async () => {
            req.url = '/api/v2/stream/task-1/progress';
            req.method = 'GET';
            req.headers['x-instance-secret'] = '';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: '' } });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should reject config refresh when configured secret is empty even if header is empty', async () => {
            req.url = '/api/v2/config/refresh';
            req.method = 'POST';
            req.headers['x-instance-secret'] = '';

            const { getConfig, refreshConfiguration } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: '' } });

            await handleWebhook(req, res);

            expect(refreshConfiguration).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should return 500 when handleIncomingChunk throws', async () => {
            req.url = '/api/v2/stream/task-1';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';
            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });
            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.handleIncomingChunk.mockRejectedValue(new Error('Unexpected failure'));

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Internal Server Error');
        });

        it('should reject stream chunk POST when configured secret is empty', async () => {
            req.url = '/api/v2/stream/task-1';
            req.method = 'POST';
            req.headers['x-instance-secret'] = '';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: '' } });

            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');

            await handleWebhook(req, res);

            expect(streamTransferService.handleIncomingChunk).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should reject stream status update when configured secret is empty', async () => {
            req.url = '/api/v2/tasks/task-1/status';
            req.method = 'POST';
            req.headers['x-instance-secret'] = '';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: '' } });

            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');

            await handleWebhook(req, res);

            expect(streamTransferService.handleStatusUpdate).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
        });

        it('should handle GET /api/v2/stream/:taskId/full-progress', async () => {
            req.url = '/api/v2/stream/task-1/full-progress';
            req.method = 'GET';
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            const fullProgress = { isActive: true, lastChunkIndex: 10, uploadedBytes: 5000, totalSize: 10000 };
            streamTransferService.getTaskFullProgress.mockResolvedValue(fullProgress);

            await handleWebhook(req, res);

            expect(streamTransferService.getTaskFullProgress).toHaveBeenCalledWith('task-1');
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify(fullProgress));
        });

        it('should handle POST /api/v2/stream/:taskId/resume', async () => {
            req.url = '/api/v2/stream/task-1/resume';
            req.method = 'POST';
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            const resumeResult = { success: true, lastChunkIndex: 10, canResume: true };
            streamTransferService.resumeTask.mockResolvedValue(resumeResult);

            await handleWebhook(req, res);

            expect(streamTransferService.resumeTask).toHaveBeenCalledWith('task-1', {});
            expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify(resumeResult));
        });

        it('should handle DELETE /api/v2/stream/:taskId/reset', async () => {
            req.url = '/api/v2/stream/task-1/reset';
            req.method = 'DELETE';
            req.headers['x-instance-secret'] = 'test-secret';

            const { getConfig } = await import('../../../src/config/index.js');
            getConfig.mockReturnValue({ streamForwarding: { secret: 'test-secret' } });

            const { streamTransferService } = await import('../../../src/services/StreamTransferService.js');
            streamTransferService.resetTask.mockResolvedValue({ success: true });

            await handleWebhook(req, res);

            expect(streamTransferService.resetTask).toHaveBeenCalledWith('task-1');
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
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ token: 'secret-token-body' }));
            };

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(401);
            expect(res.end).toHaveBeenCalledWith('Unauthorized');
            expect(webhookLog.warn).toHaveBeenCalledWith(
                expect.stringContaining('QStash 签名验证失败'),
                expect.not.objectContaining({ bodyPreview: expect.any(String) })
            );
            expect(JSON.stringify(webhookLog.warn.mock.calls)).not.toContain('secret-token-body');
        });

        it('should return 400 for invalid JSON body', async () => {
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from('invalid-json-secret-token');
            };
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(400);
            expect(res.end).toHaveBeenCalledWith('Invalid JSON');
            expect(webhookLog.warn).toHaveBeenCalledWith(
                expect.stringContaining('无效的JSON格式'),
                expect.objectContaining({ bodyBytes: 'invalid-json-secret-token'.length })
            );
            expect(webhookLog.warn).toHaveBeenCalledWith(
                expect.stringContaining('无效的JSON格式'),
                expect.not.objectContaining({ body: expect.any(String) })
            );
            expect(JSON.stringify(webhookLog.warn.mock.calls)).not.toContain('invalid-json-secret-token');
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

            vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

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


        it('should not forward webhook to leader if already forwarded to prevent loop', async () => {
            req.url = '/webhook/download';
            req.headers['x-forwarded-by-instance'] = 'some-instance';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-5' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should handle webhook forwarding when leader url cannot be resolved', async () => {
            req.url = '/webhook/download';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-6' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            const { cache } = await import('../../../src/services/CacheService.js');
            cache.get.mockResolvedValue(null); // No leader found

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
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

            vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('Upstream Error') });

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(500);
            expect(res.end).toHaveBeenCalledWith('Upstream Error');
        });


        it('should handle webhook forwarding when targetBaseUrl resolves to null', async () => {
            req.url = '/webhook/download';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-7' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            const { cache } = await import('../../../src/services/CacheService.js');
            // Make leaderInstanceId valid but no instances matching
            cache.get.mockResolvedValue({ instanceId: 'leader-instance' });

            const { instanceCoordinator } = await import('../../../src/services/InstanceCoordinator.js');
            instanceCoordinator.getActiveInstances.mockResolvedValue([]); // returns empty array, so no url

            await handleWebhook(req, res);

            // Expected to fall through to the default response from processWebhookData
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should handle AppReady state not ready within general handleWebhook flow', async () => {
            setAppReadyState(false);
            req.url = '/webhook/download';
            await handleWebhook(req, res);
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Ready');
        });

        it('should not forward webhook if x-forwarded-by-instance header is present', async () => {
            req.url = '/webhook/download';
            req.headers['x-forwarded-by-instance'] = 'another-instance';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-loop' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            // No forwarding infrastructure should be consulted
            vi.spyOn(global, 'fetch');

            await handleWebhook(req, res);

            expect(global.fetch).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });

        it('should not forward webhook if leader resolution fails', async () => {
            req.url = '/webhook/download';
            req[Symbol.asyncIterator] = async function* () {
                yield Buffer.from(JSON.stringify({ taskId: 'task-no-leader' }));
            };

            const { TaskManager } = await import('../../../src/processor/TaskManager.js');
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: false, statusCode: 503, message: 'Not Leader' });

            const { cache } = await import('../../../src/services/CacheService.js');
            cache.get.mockResolvedValue(null);

            await handleWebhook(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(503);
            expect(res.end).toHaveBeenCalledWith('Not Leader');
        });
    });
});
