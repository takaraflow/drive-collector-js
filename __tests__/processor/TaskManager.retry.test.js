// Mock all external dependencies
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

// Mock fs module
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        promises: {
            stat: vi.fn().mockResolvedValue({ size: 1000 }),
            unlink: vi.fn().mockResolvedValue(),
        },
        statSync: vi.fn().mockReturnValue({ size: 1000 }),
        unlinkSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(true),
    promises: {
        stat: vi.fn().mockResolvedValue({ size: 1000 }),
        unlink: vi.fn().mockResolvedValue(),
    },
    statSync: vi.fn().mockReturnValue({ size: 1000 }),
    unlinkSync: vi.fn(),
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
        findById: vi.fn().mockResolvedValue(null),
        findByMsgId: vi.fn().mockResolvedValue([]),
        createBatch: vi.fn().mockResolvedValue(true),
        markCancelled: vi.fn().mockResolvedValue(),
        claimTask: vi.fn().mockResolvedValue(true),
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
        acquireTaskLock: vi.fn().mockResolvedValue(true),
        releaseTaskLock: vi.fn().mockResolvedValue(true),
    },
    instanceCoordinator: {
        getInstanceId: vi.fn().mockReturnValue('test-instance'),
        isPrimary: vi.fn().mockReturnValue(true),
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(true),
        hasLock: vi.fn().mockResolvedValue(true),
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

describe('TaskManager - Retry', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Reset static properties
        TaskManager.waitingTasks = [];
        TaskManager.processingTasks = new Map();
        TaskManager.completedTasks = [];
        TaskManager.currentTask = null;
        TaskManager.waitingUploadTasks = [];
        TaskManager.processingUploadTasks = new Set();
    });

    describe('retryTask', () => {
        it('should retry a download task', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { queueService } = await import('../../src/services/QueueService.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');

            // Mock task in DB
            const taskId = 'task-123';
            const userId = 'user-1';
            const chatId = 'chat-1';
            const msgId = 'msg-1';
            const sourceMsgId = 100;

            TaskRepository.findById.mockResolvedValue({
                id: taskId,
                user_id: userId,
                chat_id: chatId,
                msg_id: msgId,
                source_msg_id: sourceMsgId,
                file_name: 'test.mp4',
                status: 'failed',
                error: 'Network error',
                type: 'download'
            });

            // Mock lock
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.releaseTaskLock.mockResolvedValue(true);

            // Mock Telegram message
            const { client } = await import('../../src/services/telegram.js');
            client.getMessages.mockResolvedValue([{
                id: sourceMsgId,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);

            // Execute retry
            const result = await TaskManager.retryTask(taskId, 'auto');

            // Verify task status update
            expect(TaskRepository.updateStatus).toHaveBeenCalledWith(taskId, 'queued');

            // Verify queue service call
            expect(queueService.enqueueDownloadTask).toHaveBeenCalledWith(
                taskId,
                expect.objectContaining({
                    userId: userId,
                    chatId: chatId,
                    msgId: msgId
                })
            );

            // Verify result
            expect(result).toEqual({ success: true, statusCode: 200, message: "Task re-enqueued for download" });
        });

        it('should retry an upload task', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { queueService } = await import('../../src/services/QueueService.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');

            // Mock task in DB
            const taskId = 'task-456';
            const userId = 'user-1';
            const chatId = 'chat-1';
            const msgId = 'msg-2';
            const sourceMsgId = 200;

            TaskRepository.findById.mockResolvedValue({
                id: taskId,
                user_id: userId,
                chat_id: chatId,
                msg_id: msgId,
                source_msg_id: sourceMsgId,
                file_name: 'test.mp4',
                status: 'downloaded',
                error: 'Upload failed',
                type: 'upload'
            });

            // Mock lock
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.releaseTaskLock.mockResolvedValue(true);

            // Mock Telegram message
            const { client } = await import('../../src/services/telegram.js');
            client.getMessages.mockResolvedValue([{
                id: sourceMsgId,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);

            // Mock file existence
            const fs = await import('fs');
            fs.existsSync.mockReturnValue(true);

            // Execute retry
            const result = await TaskManager.retryTask(taskId, 'auto');

            // Verify task status update
            expect(TaskRepository.updateStatus).toHaveBeenCalledWith(taskId, 'downloaded');

            // Verify queue service call
            expect(queueService.enqueueUploadTask).toHaveBeenCalledWith(
                taskId,
                expect.objectContaining({
                    userId: userId,
                    chatId: chatId,
                    msgId: msgId,
                    localPath: expect.stringContaining('test.mp4')
                })
            );

            // Verify result
            expect(result).toEqual({ success: true, statusCode: 200, message: "Task re-enqueued for upload" });
        });

        it('should fail if task not found', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');

            // Mock task not found
            TaskRepository.findById.mockResolvedValue(null);

            // Execute retry
            const result = await TaskManager.retryTask('non-existent-task', 'auto');

            // Verify lock was not acquired
            expect(instanceCoordinator.acquireTaskLock).not.toHaveBeenCalled();

            // Verify result
            expect(result).toEqual({ success: false, statusCode: 404, message: "Task not found" });
        });

        it('should fail if task is already completed', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');

            // Mock completed task
            TaskRepository.findById.mockResolvedValue({
                id: 'task-123',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'msg-1',
                source_msg_id: 100,
                file_name: 'test.mp4',
                status: 'completed',
                error: null,
                type: 'download'
            });

            // Execute retry
            const result = await TaskManager.retryTask('task-123', 'auto');

            // Verify lock was not acquired
            expect(instanceCoordinator.acquireTaskLock).not.toHaveBeenCalled();

            // Verify result
            expect(result).toEqual({ success: false, statusCode: 400, message: "Task already completed" });
        });

        it('should fail if task is cancelled', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');

            // Mock cancelled task
            TaskRepository.findById.mockResolvedValue({
                id: 'task-123',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'msg-1',
                source_msg_id: 100,
                file_name: 'test.mp4',
                status: 'cancelled',
                error: '用户手动取消',
                type: 'download'
            });

            // Execute retry
            const result = await TaskManager.retryTask('task-123', 'auto');

            // Verify lock was not acquired
            expect(instanceCoordinator.acquireTaskLock).not.toHaveBeenCalled();

            // Verify result
            expect(result).toEqual({ success: false, statusCode: 400, message: "Task is cancelled" });
        });


        it('should fail if Telegram message not found', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { client } = await import('../../src/services/telegram.js');

            // Mock task
            TaskRepository.findById.mockResolvedValue({
                id: 'task-123',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'msg-1',
                source_msg_id: 100,
                file_name: 'test.mp4',
                status: 'failed',
                error: 'Network error',
                type: 'download'
            });

            // Mock lock
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.releaseTaskLock.mockResolvedValue(true);

            // Mock Telegram message not found
            client.getMessages.mockResolvedValue([]);

            // Execute retry
            const result = await TaskManager.retryTask('task-123', 'auto');

            // Verify result
            expect(result).toEqual({ success: false, statusCode: 404, message: "Source message missing" });
        });

        it('should fallback to download if file not found for upload task', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { client } = await import('../../src/services/telegram.js');
            const { queueService } = await import('../../src/services/QueueService.js');

            // Mock task
            TaskRepository.findById.mockResolvedValue({
                id: 'task-456',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'msg-2',
                source_msg_id: 200,
                file_name: 'test.mp4',
                status: 'downloaded',
                error: 'Upload failed',
                type: 'upload'
            });

            // Mock lock
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.releaseTaskLock.mockResolvedValue(true);

            // Mock Telegram message
            client.getMessages.mockResolvedValue([{
                id: 200,
                media: { document: { mimeType: 'video/mp4', size: 1000, attributes: [{ className: 'DocumentAttributeFilename', fileName: 'test.mp4' }] } }
            }]);

            // Mock file not found
            const fs = await import('fs');
            // Mock both default and named export to be safe
            if (fs.default && fs.default.existsSync) {
                fs.default.existsSync.mockReturnValue(false);
            }
            if (fs.existsSync) {
                fs.existsSync.mockReturnValue(false);
            }

            // Execute retry
            const result = await TaskManager.retryTask('task-456', 'auto');

            // Verify result - Should fallback to download
            expect(result).toEqual({ success: true, statusCode: 200, message: "Task re-enqueued for download" });
            
            // Verify download queue was called instead of upload queue
            expect(queueService.enqueueDownloadTask).toHaveBeenCalledWith(
                'task-456',
                expect.objectContaining({
                    userId: 'user-1',
                    chatId: 'chat-1'
                })
            );
        });

        it('should handle errors during retry', async () => {
            const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
            const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
            const { logger } = await import('../../src/services/logger/index.js');

            // Mock task
            TaskRepository.findById.mockResolvedValue({
                id: 'task-123',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 'msg-1',
                source_msg_id: 100,
                file_name: 'test.mp4',
                status: 'failed',
                error: 'Network error',
                type: 'download'
            });

            // Mock lock
            instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
            instanceCoordinator.releaseTaskLock.mockResolvedValue(true);

            // Mock Telegram error
            const { client } = await import('../../src/services/telegram.js');
            client.getMessages.mockRejectedValue(new Error('Telegram API error'));

            // Execute retry
            const result = await TaskManager.retryTask('task-123', 'auto');

            // Verify error was logged
            expect(logger.error).toHaveBeenCalled();

            // Verify result
            expect(result).toEqual({ success: false, statusCode: 500, message: "Telegram API error" });
        });
    });
});
