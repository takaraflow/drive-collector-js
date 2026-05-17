const mockClient = {
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    getMessages: vi.fn()
};

const mockTaskRepository = {
    create: vi.fn(),
    createBatch: vi.fn(),
    findById: vi.fn(),
    findByMsgId: vi.fn(),
    transitionStatus: vi.fn()
};

const mockQueueService = {
    enqueueDownloadTask: vi.fn(),
    enqueueUploadTask: vi.fn()
};

const mockInstanceCoordinator = {
    hasLock: vi.fn(),
    getInstanceId: vi.fn(() => 'instance-1'),
    getLockLease: vi.fn(),
    isLockLeaseCurrent: vi.fn(),
    releaseTaskLock: vi.fn()
};

const mockFs = {
    existsSync: vi.fn(),
    promises: {
        stat: vi.fn(),
        unlink: vi.fn()
    },
    statSync: vi.fn(),
    unlinkSync: vi.fn()
};

vi.mock('../../src/config/index.js', () => ({
    getConfig: () => ({
        downloadDir: '/tmp/downloads',
        remoteName: 'drive',
        remoteFolder: 'remote',
        qstash: { webhookUrl: 'https://example.com' },
        streamForwarding: { enabled: false },
        oss: {}
    }),
    config: {
        downloadDir: '/tmp/downloads',
        remoteName: 'drive',
        remoteFolder: 'remote',
        qstash: { webhookUrl: 'https://example.com' },
        streamForwarding: { enabled: false },
        oss: {}
    }
}));

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient
}));

vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: mockTaskRepository
}));

vi.mock('../../src/services/QueueService.js', () => ({
    queueService: mockQueueService
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

vi.mock('../../src/utils/common.js', () => ({
    getMediaInfo: vi.fn((msg) => ({
        name: msg?.fileName || 'test.mp4',
        size: msg?.size || 1024
    })),
    updateStatus: vi.fn(),
    escapeHTML: vi.fn((value) => value),
    safeEdit: vi.fn()
}));

vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 20, BACKGROUND: -20 }
}));

vi.mock('../../src/locales/zh-CN.js', () => ({
    STRINGS: {
        task: {
            captured: 'captured',
            batch_captured: 'batch captured',
            cancel_btn: 'Cancel',
            cancel_task_btn: 'Cancel',
            cancel_transfer_btn: 'Cancel',
            create_failed: 'create failed',
            cancelled: 'cancelled',
            queued: 'queued',
            uploading: 'uploading',
            verifying: 'verifying',
            parse_failed: 'parse failed',
            downloaded_waiting_upload: 'downloaded',
            failed_validation: 'failed validation',
            failed_upload: 'failed upload',
            error_prefix: 'error: ',
            success: 'success',
            success_sec_transfer: 'success'
        }
    },
    format: vi.fn((template) => template)
}));

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: { can: vi.fn().mockResolvedValue(true) }
}));

vi.mock('../../src/services/rclone.js', () => ({
    CloudTool: {
        getRemoteFileInfo: vi.fn(),
        _getUploadPath: vi.fn(),
        uploadFile: vi.fn(),
        listRemoteFiles: vi.fn()
    }
}));

vi.mock('../../src/services/oss.js', () => ({
    ossService: { upload: vi.fn() }
}));

vi.mock('../../src/services/CacheService.js', () => ({
    cache: { isFailoverMode: false }
}));

vi.mock('../../src/services/d1.js', () => ({
    d1: { batch: vi.fn() }
}));

vi.mock('../../src/ui/templates.js', () => ({
    UIHelper: {
        renderBatchMonitor: vi.fn(() => ({ text: 'batch' })),
        renderProgress: vi.fn(() => 'progress')
    }
}));

vi.mock('fs', () => ({
    default: mockFs,
    existsSync: mockFs.existsSync,
    promises: mockFs.promises,
    statSync: mockFs.statSync,
    unlinkSync: mockFs.unlinkSync
}));

const { TaskManager } = await import('../../src/processor/TaskManager.js');
const { TaskProcessingLockBusyError } = await import('../../src/domain/task-queue-contract.js');
const { TASK_EVENTS } = await import('../../src/domain/task-state-machine.js');
const { safeEdit } = await import('../../src/utils/common.js');

describe('TaskManager queue/recovery closure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        TaskManager.cancelledTaskIds.clear();
        TaskManager.activeProcessors.clear();
        TaskManager.inFlightTasks.clear();
        TaskManager.waitingTasks = [];
        TaskManager.waitingUploadTasks = [];
        TaskManager.uiUpdateTracker = {
            count: 0,
            windowStart: Date.now(),
            windowSize: 10000,
            maxUpdates: 20
        };
        mockTaskRepository.transitionStatus.mockImplementation(async (taskId, eventOrStatus) => ({
            changed: true,
            blocked: false,
            queueAttempt: `${eventOrStatus}:${taskId}:1700000000000`
        }));
        mockTaskRepository.findByMsgId.mockResolvedValue([]);
        mockQueueService.enqueueDownloadTask.mockResolvedValue({ messageId: 'download-msg' });
        mockQueueService.enqueueUploadTask.mockResolvedValue({ messageId: 'upload-msg' });
        mockClient.sendMessage.mockResolvedValue({ id: 99 });
        mockClient.editMessage.mockResolvedValue({ id: 99 });
        mockClient.getMessages.mockResolvedValue([{ id: 10, media: { document: {} }, fileName: 'test.mp4' }]);
        mockInstanceCoordinator.hasLock.mockResolvedValue(true);
        mockInstanceCoordinator.getLockLease.mockResolvedValue({ instanceId: 'instance-1', leaseId: 'lease-1' });
        mockInstanceCoordinator.isLockLeaseCurrent.mockResolvedValue(true);
        mockFs.existsSync.mockReturnValue(true);
    });

    it('restores downloaded and uploading tasks to upload when local files exist', async () => {
        await TaskManager._restoreBatchTasks('chat-1', [
            {
                id: 'downloaded-1',
                user_id: 'u1',
                chat_id: 'chat-1',
                msg_id: 1,
                source_msg_id: 10,
                file_name: 'downloaded.mp4',
                status: 'downloaded'
            },
            {
                id: 'uploading-1',
                user_id: 'u1',
                chat_id: 'chat-1',
                msg_id: 1,
                source_msg_id: 10,
                file_name: 'uploading.mp4',
                status: 'uploading'
            }
        ]);

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'uploading-1',
            TASK_EVENTS.RESET_UPLOAD,
            null,
            expect.objectContaining({ source: 'restore_uploadable_task' })
        );
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledTimes(2);
        expect(mockQueueService.enqueueDownloadTask).not.toHaveBeenCalled();
    });

    it('resets uploading task to download when local file is missing', async () => {
        mockFs.existsSync.mockReturnValue(false);

        await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'uploading-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'uploading.mp4',
            status: 'uploading'
        }]);

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'uploading-1',
            TASK_EVENTS.RETRY,
            'Local file missing during recovery',
            expect.objectContaining({ source: 'restore_uploading_missing_file' })
        );
        expect(mockQueueService.enqueueDownloadTask).toHaveBeenCalledWith(
            'uploading-1',
            expect.objectContaining({
                userId: 'u1',
                _meta: expect.objectContaining({
                    queueAttempt: `${TASK_EVENTS.RETRY}:uploading-1:1700000000000`
                })
            })
        );
    });

    it('restores queued tasks with a fresh queue attempt so queue idempotency does not swallow recovery', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1700000001234);

        await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'queued.mp4',
            status: 'queued'
        }]);

        expect(mockQueueService.enqueueDownloadTask).toHaveBeenCalledWith(
            'queued-1',
            expect.objectContaining({
                _meta: expect.objectContaining({
                    queueAttempt: 'recovery:queued:1700000001234'
                })
            })
        );

        Date.now.mockRestore();
    });

    it('marks restored task failed and throws when recovery enqueue fails', async () => {
        mockQueueService.enqueueDownloadTask.mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(TaskManager._restoreBatchTasks('chat-1', [{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'queued.mp4',
            status: 'queued'
        }])).rejects.toThrow('Recovery enqueue failed');

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'queued-1',
            TASK_EVENTS.FAIL,
            'Recovery enqueue failed: queue unavailable',
            expect.objectContaining({ source: 'restore_download_enqueue_failed' })
        );
    });

    it('marks created single task failed and throws when enqueue fails', async () => {
        mockTaskRepository.create.mockResolvedValue(true);
        mockQueueService.enqueueDownloadTask.mockRejectedValue(new Error('qstash down'));

        await expect(TaskManager.addTask({ id: 'chat-1' }, { id: 10, media: { document: {} } }, 'user-1'))
            .rejects.toThrow('qstash down');

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            expect.any(String),
            TASK_EVENTS.FAIL,
            'Queue enqueue failed: qstash down',
            expect.objectContaining({ source: 'addTask.enqueue_failed' })
        );
        expect(mockClient.editMessage).toHaveBeenCalledWith(
            { id: 'chat-1' },
            expect.objectContaining({ text: 'create failed' })
        );
    });

    it('returns 503 and resets download state when task lock is busy after webhook claim', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'queued'
        });
        vi.spyOn(TaskManager, 'downloadTask')
            .mockRejectedValueOnce(new TaskProcessingLockBusyError('task-1', 'download'));

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result.statusCode).toBe(503);
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.START_DOWNLOAD,
            null,
            expect.objectContaining({ source: 'handleDownloadWebhook' })
        );
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.RETRY,
            'Task processing lock busy',
            expect.objectContaining({
                source: 'handleDownloadWebhook.lock_busy',
                requireClaim: true,
                claimedBy: 'instance-1',
                claimLeaseId: 'lease-1'
            })
        );
        TaskManager.downloadTask.mockRestore();
    });

    it('returns 503 and resets upload state when task lock is busy after webhook claim', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'downloaded'
        });
        vi.spyOn(TaskManager, 'uploadTask')
            .mockRejectedValueOnce(new TaskProcessingLockBusyError('task-1', 'upload'));

        const result = await TaskManager.handleUploadWebhook('task-1');

        expect(result.statusCode).toBe(503);
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.RESET_UPLOAD,
            'Task processing lock busy',
            expect.objectContaining({
                source: 'handleUploadWebhook.lock_busy',
                requireClaim: true,
                claimedBy: 'instance-1',
                claimLeaseId: 'lease-1'
            })
        );
        TaskManager.uploadTask.mockRestore();
    });

    it('does not update UI when terminal task cancellation is blocked', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            status: 'completed'
        });
        mockTaskRepository.transitionStatus.mockResolvedValueOnce({
            changed: false,
            blocked: true,
            reason: 'Cannot transition task from completed to cancelled'
        });

        const result = await TaskManager.cancelTask('task-1', 'user-1');

        expect(result).toBe(false);
        expect(safeEdit).not.toHaveBeenCalled();
        expect(TaskManager.cancelledTaskIds.has('task-1')).toBe(false);
    });
});
