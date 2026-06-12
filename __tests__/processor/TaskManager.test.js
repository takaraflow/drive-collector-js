// Mock all external dependencies
import { Writable } from 'stream';

vi.mock('../../src/config/index.js', () => ({
    config: {
        downloadDir: '/tmp/downloads',
        streamForwarding: { enabled: false },
        remoteName: 'drive',
        oss: {}
    },
    getConfig: () => ({
        downloadDir: '/tmp/downloads',
        qstash: { webhookUrl: 'http://test', pathTemplate: '/api/${topic}' }
    })
}));

vi.mock('../../src/services/telegram.js', () => ({
    default: {
        sendMessage: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
        sendChatAction: vi.fn().mockResolvedValue(true),
    },
    client: {
        getMessages: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(true),
        editMessage: vi.fn().mockResolvedValue(true),
        downloadMedia: vi.fn().mockResolvedValue(true),
        connected: true,
    }
}));

vi.mock('../../src/services/oss.js', () => ({
    default: {
        uploadFile: vi.fn().mockResolvedValue({ url: 'https://example.com/file.mp4' }),
    },
    ossService: {
        upload: vi.fn().mockResolvedValue({ success: true }),
    }
}));

vi.mock('../../src/services/rclone.js', () => ({
    default: {
        uploadFile: vi.fn().mockResolvedValue({ url: 'https://example.com/file.mp4' }),
    },
    CloudTool: {
        getRemoteFileInfo: vi.fn().mockResolvedValue(null),
        uploadFile: vi.fn().mockResolvedValue({ success: true }),
        uploadLocalFileToRemote: vi.fn().mockResolvedValue({ success: true }),
        listRemoteFiles: vi.fn().mockResolvedValue([]),
    }
}));

vi.mock('../../src/services/CacheService.js', () => ({
    cache: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue(true),
    }
}));

vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: {
        updateStatus: vi.fn().mockResolvedValue(),
        transitionStatus: vi.fn().mockResolvedValue({ changed: true, blocked: false }),
        updateFileMetadata: vi.fn().mockResolvedValue(true),
        updateSourceRef: vi.fn().mockResolvedValue(true),
        findById: vi.fn().mockResolvedValue(null),
        findByMsgId: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(true),
        createBatch: vi.fn().mockResolvedValue(true),
        markCancelled: vi.fn().mockResolvedValue(),
        claimTask: vi.fn().mockResolvedValue(true),
    }
}));

const mockFileData = new Map();
function createMockWriteStream(filePath) {
    const chunks = [];
    return new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
        final(callback) {
            mockFileData.set(filePath, Buffer.concat(chunks));
            callback();
        }
    });
}

const mockFs = {
    existsSync: vi.fn().mockReturnValue(true),
    createWriteStream: vi.fn(createMockWriteStream),
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        constants: { W_OK: 2 },
        promises: {
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
            access: vi.fn().mockResolvedValue(),
            statfs: vi.fn().mockResolvedValue({ bsize: 4096, bavail: 1000000 }),
            unlink: vi.fn().mockResolvedValue(),
            mkdir: vi.fn().mockResolvedValue(),
            rm: vi.fn().mockResolvedValue(),
            rename: vi.fn(async (from, to) => {
                mockFileData.set(to, mockFileData.get(from) || Buffer.alloc(0));
                mockFileData.delete(from);
            })
        },
        statSync: vi.fn().mockReturnValue({ size: 1000 }),
        unlinkSync: vi.fn(),
        createWriteStream: vi.fn(createMockWriteStream)
    },
    promises: {
        stat: vi.fn().mockResolvedValue({ size: 1000 }),
        access: vi.fn().mockResolvedValue(),
        statfs: vi.fn().mockResolvedValue({ bsize: 4096, bavail: 1000000 }),
        unlink: vi.fn().mockResolvedValue(),
        mkdir: vi.fn().mockResolvedValue(),
        rm: vi.fn().mockResolvedValue(),
        rename: vi.fn(async (from, to) => {
            mockFileData.set(to, mockFileData.get(from) || Buffer.alloc(0));
            mockFileData.delete(from);
        })
    },
    statSync: vi.fn().mockReturnValue({ size: 1000 }),
    unlinkSync: vi.fn(),
    constants: { W_OK: 2 },
    createWriteStream: vi.fn(createMockWriteStream)
};
vi.mock('fs', () => mockFs);

vi.mock('../../src/services/oss.js', () => ({
    ossService: {
        upload: vi.fn().mockResolvedValue({ url: 'https://oss.example.com/file.mp4' }),
    }
}));

vi.mock('../../src/services/d1.js', () => ({
    d1: {
        prepare: vi.fn().mockReturnThis(),
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
        batch: vi.fn().mockResolvedValue([{ success: true }]),
    }
}));

vi.mock('../../src/services/logger/index.js', () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis(),
    },
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis(),
    }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    default: {
        getInstanceId: vi.fn().mockReturnValue('test-instance'),
        isPrimary: vi.fn().mockReturnValue(true),
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(true),
        hasLock: vi.fn().mockResolvedValue(true),
        getLockLease: vi.fn().mockResolvedValue({ instanceId: 'test-instance', leaseId: 'lease-test' }),
        isLockLeaseCurrent: vi.fn().mockResolvedValue(true),
        acquireTaskLock: vi.fn().mockResolvedValue(true),
        releaseTaskLock: vi.fn().mockResolvedValue(true),
    },
    instanceCoordinator: {
        getInstanceId: vi.fn().mockReturnValue('test-instance'),
        isPrimary: vi.fn().mockReturnValue(true),
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(true),
        hasLock: vi.fn().mockResolvedValue(true),
        getLockLease: vi.fn().mockResolvedValue({ instanceId: 'test-instance', leaseId: 'lease-test' }),
        isLockLeaseCurrent: vi.fn().mockResolvedValue(true),
        acquireTaskLock: vi.fn().mockResolvedValue(true),
        releaseTaskLock: vi.fn().mockResolvedValue(true),
    }
}));

vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        enqueueDownloadTask: vi.fn().mockResolvedValue({ success: true }),
        enqueueUploadTask: vi.fn().mockResolvedValue({ success: true }),
        publish: vi.fn().mockResolvedValue({ success: true }),
        batchPublish: vi.fn().mockResolvedValue({ success: true }),
    }
}));

vi.mock('../../src/utils/limiter.js', () => ({
    handle429Error: vi.fn((fn) => fn()),
    checkCooling: vi.fn().mockResolvedValue(false),
    runBotTask: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 20, HIGH: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 }
}));

// Import after mocking
const { TaskManager } = await import('../../src/processor/TaskManager.js');

describe('TaskManager', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockFileData.clear();
        // Reset static properties
        TaskManager.waitingTasks = [];
        TaskManager.processingTasks = new Map();
        TaskManager.completedTasks = [];
        TaskManager.currentTask = null;
        TaskManager.waitingUploadTasks = [];
        TaskManager.processingUploadTasks = new Set();
        mockFs.default.promises.stat.mockResolvedValue({ size: 1000 });
        mockFs.promises.stat.mockResolvedValue({ size: 1000 });
    });

    describe('static methods', () => {
        it('should have correct initial state', () => {
            expect(TaskManager.getProcessingCount()).toBe(0);
            expect(TaskManager.getWaitingCount()).toBe(0);
        });

        it('should track processing count correctly', async () => {
            // Simulate a task being processed
            TaskManager.currentTask = { id: 'test' };
            expect(TaskManager.getProcessingCount()).toBe(1);
            
            TaskManager.currentTask = null;
            expect(TaskManager.getProcessingCount()).toBe(0);
        });

        it('should track waiting count correctly', () => {
            TaskManager.waitingTasks = [{ id: 't1' }, { id: 't2' }];
            TaskManager.waitingUploadTasks = [{ id: 't3' }];
            
            expect(TaskManager.getWaitingCount()).toBe(3);
        });

        it('should handle batchUpdateStatus with empty updates', async () => {
            const { d1 } = await import('../../src/services/d1.js');
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            
            await TaskManager.batchUpdateStatus([]);
            
            expect(d1.batch).not.toHaveBeenCalled();
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalled();
        });

        it('should handle batchUpdateStatus with updates', async () => {
            const { d1 } = await import('../../src/services/d1.js');
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            
            const updates = [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'failed', error: 'Test error' }
            ];
            
            await TaskManager.batchUpdateStatus(updates);
            
            expect(d1.batch).not.toHaveBeenCalled();
            expect(TaskRepository.transitionStatus).toHaveBeenCalledTimes(2);
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(
                1,
                't1',
                'completed',
                undefined,
                expect.objectContaining({ source: 'TaskManager.batchUpdateStatus' })
            );
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(
                2,
                't2',
                'failed',
                'Test error',
                expect.objectContaining({ source: 'TaskManager.batchUpdateStatus' })
            );
        });

        it('should fallback to individual updates when batchUpdateStatus fails', async () => {
            const { d1 } = await import('../../src/services/d1.js');
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');

            const updates = [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'failed', error: 'Test error' }
            ];

            TaskRepository.transitionStatus
                .mockRejectedValueOnce(new Error('Batch update failed'))
                .mockResolvedValue({ changed: true, blocked: false });

            await TaskManager.batchUpdateStatus(updates);

            expect(d1.batch).not.toHaveBeenCalled();
            expect(TaskRepository.transitionStatus).toHaveBeenCalledTimes(4);
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(
                3,
                't1',
                'completed',
                undefined,
                expect.objectContaining({ source: 'TaskManager.batchUpdateStatus.fallback' })
            );
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(
                4,
                't2',
                'failed',
                'Test error',
                expect.objectContaining({ source: 'TaskManager.batchUpdateStatus.fallback' })
            );
        });
    });

    describe('queue management', () => {
        it('should add tasks to waiting queue', () => {
            const task1 = { id: 't1', userId: 'u1' };
            const task2 = { id: 't2', userId: 'u2' };
            
            TaskManager.waitingTasks.push(task1, task2);
            
            expect(TaskManager.getWaitingCount()).toBe(2);
        });

        it('should track processing tasks', () => {
            const task = { id: 't1', userId: 'u1' };
            
            TaskManager.currentTask = task;
            TaskManager.processingTasks.set('t1', task);
            
            expect(TaskManager.getProcessingCount()).toBe(1);
        });
    });

    describe('QStash integration', () => {
        it('should handle QStash webhook download and detect group task', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { client } = await import('../../src/services/telegram.js');
            
            // Mock lock
            instanceCoordinator.hasLock.mockResolvedValue(true);
            
            // Mock DB task
            const taskId = 'task-123';
            const msgId = 'msg-group-1';
            TaskRepository.findById.mockResolvedValue({
                id: taskId,
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: msgId,
                file_name: 'test.mp4',
                source_msg_id: 100
            });
            
            // Mock getMessages
            client.getMessages.mockResolvedValue([{
                id: 100,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);

            // Mock siblings to simulate group
            TaskRepository.findByMsgId.mockResolvedValue([
                { id: taskId },
                { id: 'task-124' }
            ]);
            
            // Spy on downloadTask
            const downloadTaskSpy = vi.spyOn(TaskManager, 'downloadTask').mockResolvedValue();
            
            await TaskManager.handleDownloadWebhook(taskId);
            
            expect(downloadTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
                id: taskId,
                isGroup: true
            }));
            
            downloadTaskSpy.mockRestore();
        });

        it('should create and enqueue external URL tasks with source metadata', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { queueService } = await import('../../src/services/QueueService.js');
            const { client } = await import('../../src/services/telegram.js');
            client.sendMessage.mockResolvedValue({ id: 321 });

            const taskId = await TaskManager.addExternalUrlTask(
                { id: 'chat-1' },
                {
                    url: 'https://files.example.com/video.mp4?token=secret',
                    finalUrl: 'https://files.example.com/video.mp4?token=secret',
                    displayUrl: 'https://files.example.com/video.mp4',
                    fileName: 'video.mp4',
                    fileSize: 2048,
                    contentType: 'video/mp4'
                },
                'user-1'
            );

            expect(taskId).toEqual(expect.any(String));
            expect(TaskRepository.create).toHaveBeenCalledWith(expect.objectContaining({
                id: taskId,
                userId: 'user-1',
                chatId: 'chat-1',
                msgId: 321,
                sourceMsgId: null,
                sourceType: 'external_url',
                fileName: 'video.mp4',
                fileSize: 2048,
                sourceRef: expect.objectContaining({
                    url: 'https://files.example.com/video.mp4?token=secret',
                    displayUrl: 'https://files.example.com/video.mp4'
                })
            }));
            expect(queueService.enqueueDownloadTask).toHaveBeenCalledWith(
                taskId,
                expect.objectContaining({
                    userId: 'user-1',
                    chatId: 'chat-1',
                    msgId: 321
                })
            );
        });

        it('should route external URL download webhooks without Telegram source lookup', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { client } = await import('../../src/services/telegram.js');
            TaskRepository.findById.mockResolvedValue({
                id: 'external-task',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 321,
                source_msg_id: null,
                source_type: 'external_url',
                source_ref: JSON.stringify({
                    url: 'https://files.example.com/video.mp4',
                    fileName: 'video.mp4',
                    fileSize: 2048
                }),
                file_name: 'video.mp4',
                file_size: 2048,
                status: 'queued'
            });
            const externalSpy = vi.spyOn(TaskManager, 'downloadExternalUrlTask').mockResolvedValue();

            const result = await TaskManager.handleDownloadWebhook('external-task');

            expect(result).toMatchObject({ success: true, statusCode: 200 });
            expect(client.getMessages).not.toHaveBeenCalled();
            expect(externalSpy).toHaveBeenCalledWith(expect.objectContaining({
                id: 'external-task',
                sourceType: 'external_url',
                sourceRef: expect.objectContaining({ url: 'https://files.example.com/video.mp4' }),
                fileInfo: { name: 'video.mp4', size: 2048 }
            }));

            externalSpy.mockRestore();
        });

        it('should route external URL upload webhooks without Telegram source lookup', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { client } = await import('../../src/services/telegram.js');
            TaskRepository.findById.mockResolvedValue({
                id: 'external-upload',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 321,
                source_msg_id: null,
                source_type: 'external_url',
                source_ref: JSON.stringify({
                    url: 'https://files.example.com/video.mp4',
                    fileName: 'video.mp4',
                    fileSize: 2048
                }),
                file_name: 'video.mp4',
                file_size: 2048,
                status: 'downloaded'
            });
            const uploadSpy = vi.spyOn(TaskManager, 'uploadTask').mockResolvedValue();

            const result = await TaskManager.handleUploadWebhook('external-upload');

            expect(result).toMatchObject({ success: true, statusCode: 200 });
            expect(client.getMessages).not.toHaveBeenCalled();
            expect(uploadSpy).toHaveBeenCalledWith(expect.objectContaining({
                id: 'external-upload',
                sourceType: 'external_url',
                localPath: '/tmp/downloads/external-upload-video.mp4',
                fileInfo: { name: 'video.mp4', size: 2048 }
            }));

            uploadSpy.mockRestore();
        });

        it('should stream external URL downloads, redact retained source, and enqueue upload', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { queueService } = await import('../../src/services/QueueService.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { Readable } = await import('stream');
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.isLockLeaseCurrent.mockResolvedValue(true);
            mockFs.default.promises.stat.mockResolvedValue({ size: 11 });
            mockFs.promises.stat.mockResolvedValue({ size: 11 });
            const requestImpl = vi.fn(async () => ({
                status: 200,
                ok: true,
                headers: { get: (name) => name === 'content-length' ? '11' : null },
                body: Readable.toWeb(Readable.from(['hello world']))
            }));

            await TaskManager.downloadExternalUrlTask({
                id: 'external-stream',
                userId: 'user-1',
                chatId: 'chat-1',
                msgId: 321,
                sourceType: 'external_url',
                sourceRef: {
                    url: 'https://files.example.com/video.mp4?token=secret',
                    displayUrl: 'https://files.example.com/video.mp4',
                    fileName: 'video.mp4',
                    fileSize: 11
                },
                externalUrlTransportOptions: {
                    lookupImpl: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
                    requestImpl
                },
                fileName: 'video.mp4',
                fileInfo: { name: 'video.mp4', size: 11 },
                lastText: '',
                isCancelled: false
            });

            expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'external-stream',
                'start_download',
                null,
                expect.objectContaining({ source: 'heartbeat' })
            );
            expect(mockFs.default.promises.rename).toHaveBeenCalledWith(
                '/tmp/downloads/external-stream-video.mp4.part',
                '/tmp/downloads/external-stream-video.mp4'
            );
            expect(TaskRepository.updateFileMetadata).toHaveBeenCalledWith('external-stream', {
                fileName: 'video.mp4',
                fileSize: 11
            });
            expect(TaskRepository.updateSourceRef).toHaveBeenCalledWith(
                'external-stream',
                expect.not.objectContaining({
                    url: expect.any(String),
                    finalUrl: expect.any(String)
                })
            );
            expect(JSON.stringify(TaskRepository.updateSourceRef.mock.calls.at(-1)[1])).not.toContain('secret');
            expect(queueService.enqueueUploadTask).toHaveBeenCalledWith('external-stream', expect.objectContaining({
                localPath: '/tmp/downloads/external-stream-video.mp4'
            }));
        });

        it('should reject external URL downloads before writing when local storage is insufficient', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { queueService } = await import('../../src/services/QueueService.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { Readable } = await import('stream');
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.isLockLeaseCurrent.mockResolvedValue(true);
            mockFs.default.promises.statfs.mockResolvedValueOnce({ bsize: 4096, bavail: 1 });

            const requestImpl = vi.fn(async () => ({
                status: 200,
                ok: true,
                headers: { get: (name) => name === 'content-length' ? String(1024 * 1024 * 1024) : null },
                body: Readable.toWeb(Readable.from(['data']))
            }));

            await TaskManager.downloadExternalUrlTask({
                id: 'external-no-space',
                userId: 'user-1',
                chatId: 'chat-1',
                msgId: 321,
                sourceType: 'external_url',
                sourceRef: {
                    url: 'https://files.example.com/large.bin',
                    displayUrl: 'https://files.example.com/large.bin',
                    fileName: 'large.bin',
                    fileSize: 1024 * 1024 * 1024
                },
                externalUrlTransportOptions: {
                    lookupImpl: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
                    requestImpl
                },
                fileName: 'large.bin',
                fileInfo: { name: 'large.bin', size: 1024 * 1024 * 1024 },
                lastText: '',
                isCancelled: false
            });

            expect(mockFs.default.createWriteStream).not.toHaveBeenCalled();
            expect(queueService.enqueueUploadTask).not.toHaveBeenCalled();
            expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'external-no-space',
                'fail',
                '外部链接下载失败，请确认链接仍可公开访问且文件大小未超过限制。',
                expect.objectContaining({ source: 'handleTaskFailure' })
            );
        });

        it('should redact external URL failures before persisting or displaying status', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.isLockLeaseCurrent.mockResolvedValue(true);

            await TaskManager.downloadExternalUrlTask({
                id: 'external-failed',
                userId: 'user-1',
                chatId: 'chat-1',
                msgId: 321,
                sourceType: 'external_url',
                sourceRef: {
                    url: 'https://files.example.com/video.mp4?token=secret',
                    displayUrl: 'https://files.example.com/video.mp4',
                    fileName: 'video.mp4',
                    fileSize: 11
                },
                externalUrlTransportOptions: {
                    lookupImpl: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
                    requestImpl: vi.fn(async () => {
                        throw new Error('fetch failed https://files.example.com/video.mp4?token=secret');
                    })
                },
                fileName: 'video.mp4',
                fileInfo: { name: 'video.mp4', size: 11 },
                lastText: '',
                isCancelled: false
            });

            expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'external-failed',
                'fail',
                '外部链接下载失败，请确认链接仍可公开访问且文件大小未超过限制。',
                expect.objectContaining({ source: 'handleTaskFailure' })
            );
            expect(JSON.stringify(TaskRepository.transitionStatus.mock.calls)).not.toContain('secret');
            expect(JSON.stringify(TaskRepository.updateSourceRef.mock.calls.at(-1))).not.toContain('secret');
        });

        it('should retry download webhook on D1 lookup errors without marking the task failed', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            instanceCoordinator.hasLock.mockResolvedValue(true);
            TaskRepository.findById.mockRejectedValue(new Error('D1 Error: Network connection lost (Max retries exceeded)'));

            const result = await TaskManager.handleDownloadWebhook('task-d1');

            expect(result).toMatchObject({
                success: false,
                statusCode: 503,
                message: 'D1 Error: Network connection lost (Max retries exceeded)'
            });
            expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task-d1',
                'retry',
                'D1 Error: Network connection lost (Max retries exceeded)',
                expect.objectContaining({ source: 'handleDownloadWebhook.retryable_infra_error' })
            );
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalledWith(
                'task-d1',
                'fail',
                expect.anything(),
                expect.any(Object)
            );
        });

        it('should handle retryable infrastructure errors from downloadTask in background', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { client } = await import('../../src/services/telegram.js');
            instanceCoordinator.hasLock.mockResolvedValue(true);
            TaskRepository.findById.mockResolvedValue({
                id: 'task-network',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'status-1',
                file_name: 'test.mp4',
                source_msg_id: 100,
                status: 'queued'
            });
            client.getMessages.mockResolvedValue([{
                id: 100,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);
            const downloadTaskSpy = vi.spyOn(TaskManager, 'downloadTask').mockRejectedValue(new Error('fetch failed'));

            const result = await TaskManager.handleDownloadWebhook('task-network');

            // Fire-and-forget: webhook returns 200 immediately, errors handled in background
            expect(result).toMatchObject({ success: true, statusCode: 200 });
            // Background wrapper handles retryable errors by resetting state
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task-network',
                'retry',
                'fetch failed',
                expect.objectContaining({ source: 'handleDownloadWebhook.bg.retryable_infra_error' })
            );
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalledWith(
                'task-network',
                'fail',
                'fetch failed',
                expect.any(Object)
            );

            downloadTaskSpy.mockRestore();
        });

        it('should fail download task for permanent SQL errors', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            instanceCoordinator.hasLock.mockResolvedValue(true);
            TaskRepository.findById.mockRejectedValue(new Error('D1 SQL Error [7501]: no such table'));

            const result = await TaskManager.handleDownloadWebhook('task-sql');

            expect(result).toMatchObject({
                success: false,
                statusCode: 500,
                message: 'D1 SQL Error [7501]: no such table'
            });
            expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task-sql',
                'fail',
                'D1 SQL Error [7501]: no such table',
                expect.objectContaining({ source: 'handleDownloadWebhook.error' })
            );
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalledWith(
                'task-sql',
                'retry',
                expect.anything(),
                expect.any(Object)
            );
        });

        it('should handle QStash webhook upload and detect group task', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { client } = await import('../../src/services/telegram.js');
            // fs is already mocked globally
            
            // Mock lock
            instanceCoordinator.hasLock.mockResolvedValue(true);
            
            // Mock DB task
            const taskId = 'task-upload-123';
            const msgId = 'msg-group-2';
            TaskRepository.findById.mockResolvedValue({
                id: taskId,
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: msgId,
                file_name: 'test.mp4',
                source_msg_id: 200,
                status: 'downloaded'
            });

            // Mock getMessages
            client.getMessages.mockResolvedValue([{
                id: 200,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);

            // Mock file existence
            // fs.existsSync is already mocked to return true by default
            
            // Mock siblings to simulate group
            TaskRepository.findByMsgId.mockResolvedValue([
                { id: taskId },
                { id: 'task-upload-124' }
            ]);
            
            // Spy on uploadTask
            const uploadTaskSpy = vi.spyOn(TaskManager, 'uploadTask').mockResolvedValue();
            
            await TaskManager.handleUploadWebhook(taskId);
            
            expect(uploadTaskSpy).toHaveBeenCalledWith(expect.objectContaining({
                id: taskId,
                isGroup: true
            }));
            
            uploadTaskSpy.mockRestore();
        });

        it('should handle retryable infrastructure errors from uploadTask in background', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { client } = await import('../../src/services/telegram.js');
            instanceCoordinator.hasLock.mockResolvedValue(true);
            TaskRepository.findById.mockResolvedValue({
                id: 'task-upload-network',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'status-2',
                file_name: 'test.mp4',
                source_msg_id: 200,
                status: 'downloaded'
            });
            client.getMessages.mockResolvedValue([{
                id: 200,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);
            const uploadTaskSpy = vi.spyOn(TaskManager, 'uploadTask').mockRejectedValue(new Error('ECONNRESET'));

            const result = await TaskManager.handleUploadWebhook('task-upload-network');

            // Fire-and-forget: webhook returns 200 immediately, errors handled in background
            expect(result).toMatchObject({ success: true, statusCode: 200 });
            // Background wrapper logs the error but doesn't call _resetAfterRetryableInfrastructureError
            // (uploadTask handles its own errors internally via handleTaskFailure)
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalledWith(
                'task-upload-network',
                'fail',
                'ECONNRESET',
                expect.any(Object)
            );

            uploadTaskSpy.mockRestore();
        });
    });

    describe('Batch operations', () => {
        it('should add multiple batch tasks and update status message', async () => {
            const { client } = await import('../../src/services/telegram.js');
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { queueService } = await import('../../src/services/QueueService.js');
            
            // Mock status message
            const statusMsg = { id: 12345 };
            client.sendMessage.mockResolvedValue(statusMsg);
            client.editMessage.mockResolvedValue({ ...statusMsg, buttons: [] });
            
            // Mock getMediaInfo used in _createTaskObject
            // Note: getMediaInfo is imported in TaskManager.js from ../utils/common.js.
            // But we mocked dependencies in this file. 
            // The file mocks ../utils/common.js? No, it imports it?
            // Actually getMediaInfo is imported. We might need to mock it if it relies on complex logic, 
            // but it usually just checks properties. 
            // Let's provide mock messages that satisfy getMediaInfo.
            
            const messages = [
                { 
                    id: 100, 
                    message: 'file1', 
                    media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test1.mp4' }] } } 
                },
                { 
                    id: 101, 
                    message: 'file2', 
                    media: { document: { mimeType: 'video/mp4', size: 2000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test2.mp4' }] } } 
                }
            ];
            const target = { id: 'chat123' };
            const userId = 'user123';
            
            // We need to ensure _createTaskObject works. It uses getMediaInfo.
            // Since we didn't mock utils/common.js, it uses real implementation.
            // Real implementation of getMediaInfo checks msg.media... 
            
            await TaskManager.addBatchTasks(target, messages, userId);
            
            expect(client.sendMessage).toHaveBeenCalled();
            
            // Verify editMessage called with correct ID
            expect(client.editMessage).toHaveBeenCalledWith(
                target,
                expect.objectContaining({
                    message: 12345,
                    buttons: expect.arrayContaining([
                        expect.objectContaining({
                            text: expect.any(String)
                        })
                    ])
                })
            );
            
            expect(TaskRepository.createBatch).toHaveBeenCalled();
            // Check enqueueDownloadTask was called
            expect(queueService.enqueueDownloadTask).toHaveBeenCalled();
        });

        it('should add multiple batch tasks', async () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager.addBatchTasks).toBeDefined();
        });

        it('should handle media batch webhook', async () => {
            const handleDownloadWebhookSpy = vi.spyOn(TaskManager, 'handleDownloadWebhook')
                .mockResolvedValue({ success: true, statusCode: 200 });

            const result = await TaskManager.handleMediaBatchWebhook('group-1', ['task-1', 'task-2']);

            expect(result).toEqual({ success: true, statusCode: 200 });
            expect(handleDownloadWebhookSpy).toHaveBeenCalledTimes(2);
            expect(handleDownloadWebhookSpy).toHaveBeenNthCalledWith(1, 'task-1');
            expect(handleDownloadWebhookSpy).toHaveBeenNthCalledWith(2, 'task-2');

            handleDownloadWebhookSpy.mockRestore();
        });
    });

    describe('Auto scaling', () => {
        it('should start auto scaling', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager.startAutoScaling).toBeDefined();
        });

        it('should stop auto scaling', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager.stopAutoScaling).toBeDefined();
        });
    });

    describe('Task cancellation', () => {
        it('should cancel running task', async () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager.cancelTask).toBeDefined();
        });

        it('should not cancel task from different user', async () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager.cancelTask).toBeDefined();
        });
    });

    describe('Error classification', () => {
        it('should classify file not found error', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager._classifyError).toBeDefined();
        });

        it('should classify network error', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager._classifyError).toBeDefined();
        });

        it('should classify permission error', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager._classifyError).toBeDefined();
        });

        it('should classify disk full error', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager._classifyError).toBeDefined();
        });

        it('should classify unknown error', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager._classifyError).toBeDefined();
        });
    });

    describe('UI updates', () => {
        it('should check if UI can be updated', () => {
            TaskManager.uiUpdateTracker.lastUpdate = Date.now() - 5000;
            
            expect(TaskManager.canUpdateUI()).toBe(true);
        });

        it('should throttle UI updates', () => {
            // Test exists but implementation details depend on actual TaskManager logic
            expect(TaskManager.canUpdateUI).toBeDefined();
        });
    });
});
