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
    findStalledTasks: vi.fn(),
    transitionStatus: vi.fn(),
    updateFileMetadata: vi.fn()
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
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    acquireTaskLock: vi.fn(),
    releaseStaleTaskLock: vi.fn(),
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
    safeEdit: vi.fn(),
    formatBytes: vi.fn((bytes) => `${bytes} B`)
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
            failed_action_required: 'failed: {{reason}}',
            restore: 'restore',
            recovery_pending: 'recovery pending',
            error_prefix: 'error: ',
            success: 'success',
            success_sec_transfer: 'success'
        }
    },
    format: vi.fn((template, vars = {}) => Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, value), template))
}));

const mockTaskManagerLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn()
};
mockTaskManagerLogger.withContext.mockReturnValue(mockTaskManagerLogger);

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn(() => mockTaskManagerLogger),
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
const { TASK_EVENTS, TASK_STATUSES } = await import('../../src/domain/task-state-machine.js');
const { safeEdit } = await import('../../src/utils/common.js');
const { CloudTool } = await import('../../src/services/rclone.js');

describe('TaskManager queue/recovery closure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        TaskManager.cancelledTaskIds.clear();
        TaskManager.activeProcessors.clear();
        TaskManager.inFlightTasks.clear();
        TaskManager.waitingTasks = [];
        TaskManager.waitingUploadTasks = [];
        TaskManager.stopStalledRecoveryLoop();
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
        mockTaskRepository.findById.mockResolvedValue(null);
        mockTaskRepository.findStalledTasks.mockResolvedValue([]);
        mockTaskRepository.findByMsgId.mockResolvedValue([]);
        mockQueueService.enqueueDownloadTask.mockResolvedValue({ messageId: 'download-msg' });
        mockQueueService.enqueueUploadTask.mockResolvedValue({ messageId: 'upload-msg' });
        mockClient.sendMessage.mockResolvedValue({ id: 99 });
        mockClient.editMessage.mockResolvedValue({ id: 99 });
        mockClient.getMessages.mockResolvedValue([{ id: 10, media: { document: {} }, fileName: 'test.mp4' }]);
        mockInstanceCoordinator.hasLock.mockResolvedValue(true);
        mockInstanceCoordinator.getLockLease.mockResolvedValue({ instanceId: 'instance-1', leaseId: 'lease-1' });
        mockInstanceCoordinator.isLockLeaseCurrent.mockResolvedValue(true);
        mockInstanceCoordinator.acquireLock.mockResolvedValue(true);
        mockInstanceCoordinator.releaseLock.mockResolvedValue(true);
        mockInstanceCoordinator.acquireTaskLock.mockResolvedValue(true);
        mockInstanceCoordinator.releaseStaleTaskLock.mockResolvedValue(false);
        mockInstanceCoordinator.releaseTaskLock.mockResolvedValue(true);
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
        expect(mockClient.getMessages).not.toHaveBeenCalled();
    });

    it('restores queued Telegram tasks without fetching source messages during recovery planning', async () => {
        await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'queued.mp4',
            file_size: 1024,
            status: 'queued'
        }]);

        expect(mockClient.getMessages).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'queued-1',
            TASK_EVENTS.RETRY,
            null,
            expect.objectContaining({ source: 'restore_queued_task' })
        );
        expect(mockQueueService.enqueueDownloadTask).toHaveBeenCalledWith(
            'queued-1',
            expect.objectContaining({
                _meta: expect.objectContaining({
                    queueAttempt: `${TASK_EVENTS.RETRY}:queued-1:1700000000000`
                })
            })
        );
    });

    it('restores external URL tasks without fetching Telegram source messages', async () => {
        await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'external-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 2,
            source_msg_id: null,
            source_type: 'external_url',
            source_ref: JSON.stringify({
                url: 'https://files.example.com/report.pdf',
                fileName: 'report.pdf',
                fileSize: 2048
            }),
            file_name: 'report.pdf',
            file_size: 2048,
            status: 'downloaded'
        }]);

        expect(mockClient.getMessages).not.toHaveBeenCalled();
        expect(mockFs.existsSync).toHaveBeenCalledWith('/tmp/downloads/external-1-report.pdf');
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            'external-1',
            expect.objectContaining({
                localPath: '/tmp/downloads/external-1-report.pdf'
            })
        );
    });

    it('skips stalled recovery init when another instance owns the recovery lease', async () => {
        mockInstanceCoordinator.acquireLock.mockResolvedValueOnce(false);

        await TaskManager.init();

        expect(mockTaskRepository.findStalledTasks).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseLock).not.toHaveBeenCalled();
    });

    it('holds and releases a recovery lease around stalled recovery init', async () => {
        mockTaskRepository.findStalledTasks.mockResolvedValue([]);

        await TaskManager.init();

        expect(mockInstanceCoordinator.acquireLock).toHaveBeenCalledWith(
            'task_recovery:stalled',
            120,
            expect.objectContaining({ maxAttempts: 1, logContention: false })
        );
        expect(mockTaskRepository.findStalledTasks).toHaveBeenCalledWith(120000, {
            includeRetryableFailed: true
        });
        expect(mockInstanceCoordinator.releaseLock).toHaveBeenCalledWith('task_recovery:stalled');
    });

    it('does not touch stalled queued tasks when the recovery scanner is not the Telegram leader', async () => {
        mockInstanceCoordinator.getLockLease.mockResolvedValueOnce(null);
        mockTaskRepository.findStalledTasks.mockResolvedValue([{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'queued.mp4',
            file_size: 1024,
            status: 'queued'
        }]);

        const result = await TaskManager._runStalledTaskRecovery({ includeRetryableFailed: true });

        expect(result).toMatchObject({
            restored: 0,
            skipped: true,
            reason: 'not_telegram_leader'
        });
        expect(mockInstanceCoordinator.acquireLock).not.toHaveBeenCalledWith(
            'task_recovery:stalled',
            expect.anything(),
            expect.anything()
        );
        expect(mockTaskRepository.findStalledTasks).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            'queued-1',
            TASK_EVENTS.RETRY,
            expect.anything(),
            expect.objectContaining({ source: 'restore_queued_task' })
        );
        expect(mockQueueService.enqueueDownloadTask).not.toHaveBeenCalled();
    });

    it('retries retryable failed tasks by resetting them to the download queue', async () => {
        const result = await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'failed-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'failed.mp4',
            status: 'failed',
            error_msg: 'Queue enqueue failed: qstash down'
        }]);

        expect(result).toMatchObject({ enqueued: 1, pendingRetry: 0, failed: 0 });
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'failed-1',
            TASK_EVENTS.RETRY,
            'Downloading interrupted during recovery',
            expect.objectContaining({ source: 'restore_retryable_failed_task' })
        );
        expect(mockQueueService.enqueueDownloadTask).toHaveBeenCalledWith(
            'failed-1',
            expect.objectContaining({
                _meta: expect.objectContaining({
                    queueAttempt: `${TASK_EVENTS.RETRY}:failed-1:1700000000000`
                })
            })
        );
    });

    it('retries failed direct-transfer transient tasks during stalled recovery', async () => {
        const result = await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'failed-timeout-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'failed-timeout.mp4',
            status: 'failed',
            error_msg: 'Zero-disk direct transfer failed: TIMEOUT RCLONE_TRANSIENT'
        }]);

        expect(result).toMatchObject({ enqueued: 1, pendingRetry: 0, failed: 0 });
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'failed-timeout-1',
            TASK_EVENTS.RETRY,
            'Downloading interrupted during recovery',
            expect.objectContaining({ source: 'restore_retryable_failed_task' })
        );
        expect(mockQueueService.enqueueDownloadTask).toHaveBeenCalledWith(
            'failed-timeout-1',
            expect.objectContaining({
                _meta: expect.objectContaining({
                    queueAttempt: `${TASK_EVENTS.RETRY}:failed-timeout-1:1700000000000`
                })
            })
        );
    });

    it('does not automatically retry non-infrastructure failed tasks', async () => {
        const { updateStatus } = await import('../../src/utils/common.js');

        const result = await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'failed-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'failed.mp4',
            status: 'failed',
            error_msg: 'Rclone exited with code 1'
        }]);

        expect(result).toMatchObject({ enqueued: 0, pendingRetry: 0, failed: 0 });
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            'failed-1',
            TASK_EVENTS.RETRY,
            expect.anything(),
            expect.anything()
        );
        expect(mockQueueService.enqueueDownloadTask).not.toHaveBeenCalled();
        expect(updateStatus).not.toHaveBeenCalledWith(expect.anything(), 'restore');
    });

    it('does not show restored UI when recovery is blocked before enqueue', async () => {
        const { updateStatus } = await import('../../src/utils/common.js');
        mockTaskRepository.transitionStatus.mockResolvedValueOnce({
            changed: false,
            blocked: true,
            reason: 'Cannot transition task from completed to queued'
        });

        const result = await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'downloading-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'downloading.mp4',
            status: 'downloading'
        }]);

        expect(result).toMatchObject({ enqueued: 0, pendingRetry: 0, failed: 0 });
        expect(mockQueueService.enqueueDownloadTask).not.toHaveBeenCalled();
        expect(updateStatus).not.toHaveBeenCalledWith(expect.anything(), 'restore');
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

    it('restores queued tasks with a state-machine queue attempt so queue idempotency does not swallow recovery', async () => {
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
                    queueAttempt: `${TASK_EVENTS.RETRY}:queued-1:1700000000000`
                })
            })
        );
    });

    it('keeps restored task recoverable when recovery enqueue hits retryable infrastructure failure', async () => {
        const { updateStatus } = await import('../../src/utils/common.js');
        mockQueueService.enqueueDownloadTask.mockRejectedValueOnce(new Error('Circuit breaker is OPEN for qstash_publish'));
        const fallbackSpy = vi.spyOn(TaskManager, 'handleDownloadWebhook').mockResolvedValueOnce({
            success: false,
            statusCode: 503,
            message: 'Service Unavailable - Not Leader'
        });

        const result = await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'queued.mp4',
            status: 'queued'
        }]);

        expect(result).toMatchObject({ enqueued: 0, pendingRetry: 1, failed: 0 });
        expect(fallbackSpy).toHaveBeenCalledWith('queued-1');
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            'queued-1',
            TASK_EVENTS.FAIL,
            expect.anything(),
            expect.anything()
        );
        expect(updateStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'queued-1' }),
            'recovery pending',
            false
        );
        fallbackSpy.mockRestore();
    });

    it('directly runs recovered download task when durable queue publish is temporarily unavailable', async () => {
        const { updateStatus } = await import('../../src/utils/common.js');
        mockQueueService.enqueueDownloadTask.mockRejectedValueOnce(new Error('Circuit breaker is OPEN for qstash_publish'));
        const fallbackSpy = vi.spyOn(TaskManager, 'handleDownloadWebhook').mockResolvedValueOnce({
            success: true,
            statusCode: 200
        });

        const result = await TaskManager._restoreBatchTasks('chat-1', [{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'queued.mp4',
            status: 'queued'
        }]);

        expect(result).toMatchObject({ enqueued: 1, pendingRetry: 0, failed: 0 });
        expect(fallbackSpy).toHaveBeenCalledWith('queued-1');
        expect(updateStatus).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: 'queued-1' }),
            'recovery pending',
            false
        );
        fallbackSpy.mockRestore();
    });

    it('executes recovered download locally on the Telegram leader when durable queue publish is temporarily unavailable', async () => {
        mockTaskRepository.findStalledTasks.mockResolvedValue([{
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'queued.mp4',
            file_size: 1024,
            status: 'queued'
        }]);
        mockTaskRepository.findById.mockResolvedValue({
            id: 'queued-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'queued.mp4',
            file_size: 1024,
            status: 'queued'
        });
        mockQueueService.enqueueDownloadTask.mockRejectedValueOnce(new Error('Circuit breaker is OPEN for qstash_publish'));
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask').mockResolvedValueOnce(undefined);

        const result = await TaskManager._runStalledTaskRecovery({ includeRetryableFailed: true });

        expect(result).toMatchObject({ restored: 1, skipped: false });
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'queued-1',
            TASK_EVENTS.RETRY,
            null,
            expect.objectContaining({ source: 'restore_queued_task' })
        );
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'queued-1',
            TASK_EVENTS.START_DOWNLOAD,
            null,
            expect.objectContaining({
                claimedBy: 'instance-1',
                claimLeaseId: 'lease-1',
                source: 'handleDownloadWebhook'
            })
        );
        expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'queued-1',
            processingLockHeld: true,
            claimedBy: 'instance-1',
            claimLeaseId: 'lease-1'
        }));
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('queued-1');
        downloadSpy.mockRestore();
    });

    it('marks restored task failed and updates UI when recovery enqueue fails permanently', async () => {
        const { updateStatus } = await import('../../src/utils/common.js');
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
        expect(updateStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'queued-1' }),
            expect.stringContaining('恢复队列失败：queue unavailable'),
            true
        );
    });

    it('counts only tasks actually enqueued during stalled recovery', async () => {
        mockTaskRepository.findStalledTasks.mockResolvedValue([
            {
                id: 'queued-1',
                user_id: 'u1',
                chat_id: 'chat-1',
                msg_id: 1,
                source_msg_id: 10,
                file_name: 'queued.mp4',
                status: 'queued'
            },
            {
                id: 'queued-2',
                user_id: 'u1',
                chat_id: 'chat-1',
                msg_id: 2,
                source_msg_id: 10,
                file_name: 'queued2.mp4',
                status: 'queued'
            }
        ]);
        mockQueueService.enqueueDownloadTask
            .mockResolvedValueOnce({ messageId: 'download-msg' })
            .mockRejectedValueOnce(new Error('Circuit breaker is OPEN for qstash_publish'));

        const result = await TaskManager._runStalledTaskRecovery({ includeRetryableFailed: true });

        expect(result).toMatchObject({ restored: 1, skipped: false });
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

    it('returns 503 without touching task state when download processing lock is busy', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'queued'
        });
        mockInstanceCoordinator.acquireTaskLock.mockResolvedValueOnce(false);

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result.statusCode).toBe(503);
        expect(result.message).toContain('Task processing lock busy');
        expect(mockTaskManagerLogger.error).not.toHaveBeenCalledWith(
            'Download webhook failed',
            expect.anything()
        );
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseTaskLock).not.toHaveBeenCalled();
    });

    it('clears a stale download processing lock only when canonical task state is idle', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'test.mp4',
            status: TASK_STATUSES.QUEUED,
            claimed_by: null,
            claim_lease_id: null
        });
        mockInstanceCoordinator.acquireTaskLock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        mockInstanceCoordinator.releaseStaleTaskLock.mockResolvedValueOnce(true);
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask').mockResolvedValueOnce(undefined);

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result).toEqual({ success: true, statusCode: 200 });
        expect(mockInstanceCoordinator.releaseStaleTaskLock).toHaveBeenCalledWith('task-1');
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.START_DOWNLOAD,
            null,
            expect.objectContaining({
                claimedBy: 'instance-1',
                claimLeaseId: 'lease-1'
            })
        );
        expect(downloadSpy).toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-1');
        downloadSpy.mockRestore();
    });

    it('does not clear a busy download processing lock while canonical task state is claimed', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: TASK_STATUSES.DOWNLOADING,
            claimed_by: 'instance-2',
            claim_lease_id: 'lease-2'
        });
        mockInstanceCoordinator.acquireTaskLock.mockResolvedValueOnce(false);

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result.statusCode).toBe(503);
        expect(result.message).toContain('Task processing lock busy');
        expect(mockInstanceCoordinator.releaseStaleTaskLock).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('returns 503 when active download webhook is blocked by the state machine', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: TASK_STATUSES.UPLOADING
        });
        mockTaskRepository.transitionStatus.mockResolvedValueOnce({
            changed: false,
            blocked: true,
            reason: 'Task status changed concurrently from downloading to uploading',
            fromStatus: TASK_STATUSES.UPLOADING,
            toStatus: TASK_STATUSES.DOWNLOADING
        });
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask');

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result).toMatchObject({
            success: false,
            statusCode: 503,
            message: 'download task is active; retry later'
        });
        expect(downloadSpy).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-1');
        downloadSpy.mockRestore();
    });

    it('acks terminal download webhook blocked by the state machine', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: TASK_STATUSES.COMPLETED
        });
        mockTaskRepository.transitionStatus.mockResolvedValueOnce({
            changed: false,
            blocked: true,
            reason: 'Cannot transition task from completed to downloading',
            fromStatus: TASK_STATUSES.COMPLETED,
            toStatus: TASK_STATUSES.DOWNLOADING
        });
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask');

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result).toMatchObject({
            success: true,
            statusCode: 200,
            message: 'Task already terminal'
        });
        expect(downloadSpy).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-1');
        downloadSpy.mockRestore();
    });

    it('returns 503 when active upload webhook is blocked by the state machine', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: TASK_STATUSES.DOWNLOADING
        });
        mockTaskRepository.transitionStatus.mockResolvedValueOnce({
            changed: false,
            blocked: true,
            reason: 'Cannot transition task from downloading to uploading',
            fromStatus: TASK_STATUSES.DOWNLOADING,
            toStatus: TASK_STATUSES.UPLOADING
        });
        const uploadSpy = vi.spyOn(TaskManager, 'uploadTask');

        const result = await TaskManager.handleUploadWebhook('task-1');

        expect(result).toMatchObject({
            success: false,
            statusCode: 503,
            message: 'upload task is active; retry later'
        });
        expect(uploadSpy).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-1');
        uploadSpy.mockRestore();
    });

    it('returns 503 without touching task state when upload processing lock is busy', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'downloaded'
        });
        mockInstanceCoordinator.acquireTaskLock.mockResolvedValueOnce(false);

        const result = await TaskManager.handleUploadWebhook('task-1');

        expect(result.statusCode).toBe(503);
        expect(result.message).toContain('Task processing lock busy');
        expect(mockTaskManagerLogger.error).not.toHaveBeenCalledWith(
            'Upload webhook failed',
            expect.anything()
        );
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.releaseTaskLock).not.toHaveBeenCalled();
    });

    it('handles upload webhook from stored task metadata without fetching Telegram source message', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'test.mp4',
            file_size: 1024,
            status: 'downloaded'
        });
        mockFs.existsSync.mockReturnValue(true);
        mockFs.statSync.mockReturnValue({ size: 1024 });
        CloudTool.getRemoteFileInfo
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ Size: 1024 });
        CloudTool.uploadFile.mockResolvedValue({ success: true });
        CloudTool._getUploadPath.mockResolvedValue('/remote');

        const result = await TaskManager.handleUploadWebhook('task-1');

        // Fire-and-forget: webhook returns 200 immediately
        expect(result).toMatchObject({ success: true, statusCode: 200 });
        // Wait for background upload to complete (includes 3s validation delay)
        await new Promise(resolve => setTimeout(resolve, 4000));
        expect(mockClient.getMessages).not.toHaveBeenCalled();
        expect(CloudTool.uploadFile).toHaveBeenCalledWith(
            '/tmp/downloads/test.mp4',
            expect.objectContaining({
                id: 'task-1',
                message: null,
                sourceRef: expect.objectContaining({ messageId: 10 }),
                sourceMsgId: 10,
                localPath: '/tmp/downloads/test.mp4'
            }),
            expect.any(Function)
        );
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.COMPLETE,
            null,
            expect.objectContaining({ source: 'upload_validation' })
        );
    });

    it('passes a held processing lock into download task and releases it after completion', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'queued'
        });
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask').mockResolvedValueOnce(undefined);

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result.statusCode).toBe(200);
        expect(mockInstanceCoordinator.acquireTaskLock).toHaveBeenCalledWith('task-1');
        expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'task-1',
            processingLockHeld: true,
            claimedBy: 'instance-1',
            claimLeaseId: 'lease-1'
        }));
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-1');
        downloadSpy.mockRestore();
    });

    it('repairs a downloaded task by enqueueing upload instead of re-downloading', async () => {
        mockTaskRepository.findById.mockResolvedValue({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'downloaded'
        });
        mockFs.existsSync.mockReturnValue(true);
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask');

        const result = await TaskManager.handleDownloadWebhook('task-1');

        expect(result).toMatchObject({
            success: true,
            statusCode: 200,
            message: 'Upload task re-enqueued'
        });
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.RESET_UPLOAD,
            null,
            expect.objectContaining({ source: 'handleDownloadWebhook.upload_queue_repair' })
        );
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({
                localPath: '/tmp/downloads/test.mp4',
                _meta: expect.objectContaining({
                    queueAttempt: `${TASK_EVENTS.RESET_UPLOAD}:task-1:1700000000000`
                })
            })
        );
        expect(downloadSpy).not.toHaveBeenCalled();
        expect(mockInstanceCoordinator.acquireTaskLock).toHaveBeenCalledWith('task-1');
        expect(mockInstanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-1');
    });

    it('resets downloaded task to upload retry when QStash publish fails after download', async () => {
        mockTaskRepository.findById
            .mockResolvedValueOnce({
                id: 'task-1',
                user_id: 'user-1',
                chat_id: 'chat-1',
                msg_id: 1,
                source_msg_id: 10,
                file_name: 'test.mp4',
                status: 'queued'
            })
            .mockResolvedValueOnce({
                id: 'task-1',
                status: 'downloaded',
                file_name: 'test.mp4'
            });
        const circuitError = new Error('Circuit breaker is OPEN for qstash_publish');
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask').mockRejectedValueOnce(circuitError);

        const result = await TaskManager.handleDownloadWebhook('task-1');

        // Fire-and-forget: webhook returns 200 immediately, error handled in background
        expect(result).toMatchObject({ success: true, statusCode: 200 });
        // Background wrapper handles retryable errors by resetting state
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.RESET_UPLOAD,
            'Circuit breaker is OPEN for qstash_publish',
            expect.objectContaining({ source: 'handleDownloadWebhook.bg.retryable_infra_error' })
        );
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            'task-1',
            TASK_EVENTS.FAIL,
            expect.anything(),
            expect.anything()
        );
        downloadSpy.mockRestore();
    });

    it('does not mark a task failed when the active worker loses its claim lease', async () => {
        mockTaskRepository.findById.mockResolvedValueOnce({
            id: 'task-lease-stale',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'test.mp4',
            status: 'queued'
        });
        const staleLeaseError = Object.assign(new Error('Task claim lease is no longer current'), {
            code: 'TASK_CLAIM_LEASE_STALE',
            retryable: true,
            retryScope: 'lock'
        });
        const downloadSpy = vi.spyOn(TaskManager, 'downloadTask').mockRejectedValueOnce(staleLeaseError);

        const result = await TaskManager.handleDownloadWebhook('task-lease-stale');

        // Fire-and-forget: webhook returns 200 immediately, error handled in background
        expect(result).toMatchObject({ success: true, statusCode: 200 });
        // Background wrapper handles claim fence stale errors silently
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            'task-lease-stale',
            TASK_EVENTS.FAIL,
            expect.anything(),
            expect.anything()
        );

        downloadSpy.mockRestore();
    });

    it('executes recovery fallback tasks sequentially with delay', async () => {
        const fallbackSpy = vi.spyOn(TaskManager, 'handleDownloadWebhook').mockResolvedValue({
            success: true,
            statusCode: 200
        });
        mockQueueService.enqueueDownloadTask.mockRejectedValue(new Error('Circuit breaker is OPEN'));

        const start = Date.now();
        const result = await TaskManager._restoreBatchTasks('chat-1', [
            {
                id: 'queued-1',
                user_id: 'u1',
                chat_id: 'chat-1',
                msg_id: 1,
                source_msg_id: 10,
                file_name: 'queued1.mp4',
                status: 'queued'
            },
            {
                id: 'queued-2',
                user_id: 'u1',
                chat_id: 'chat-1',
                msg_id: 2,
                source_msg_id: 11,
                file_name: 'queued2.mp4',
                status: 'queued'
            }
        ]);
        const elapsed = Date.now() - start;

        expect(result).toMatchObject({ enqueued: 2, pendingRetry: 0, failed: 0 });
        expect(fallbackSpy).toHaveBeenCalledTimes(2);
        expect(elapsed).toBeGreaterThanOrEqual(4000);
        fallbackSpy.mockRestore();
    });

    it('skips 429-failed tasks during recovery when within cooldown window', async () => {
        const recent429 = {
            id: 'rate-limited-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'rate-limited.mp4',
            status: 'failed',
            error_msg: 'Max retries (10) exceeded for 429 errors',
            updated_at: Date.now() - 60_000
        };

        expect(TaskManager._isRetryableStalledFailure(recent429)).toBe(false);
    });

    it('recovers 429-failed tasks after cooldown period expires', async () => {
        const old429 = {
            id: 'rate-limited-old',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            file_name: 'rate-limited-old.mp4',
            status: 'failed',
            error_msg: 'Max retries (10) exceeded for 429 errors',
            updated_at: Date.now() - 6 * 60_000
        };

        expect(TaskManager._isRetryableStalledFailure(old429)).toBe(true);
    });

    it('skips rate limit failed tasks during stalled recovery scan', async () => {
        mockTaskRepository.findStalledTasks.mockResolvedValue([{
            id: 'rate-limited-1',
            user_id: 'u1',
            chat_id: 'chat-1',
            msg_id: 1,
            source_msg_id: 10,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 10 }),
            file_name: 'rate-limited.mp4',
            file_size: 1024,
            status: 'failed',
            error_msg: 'Max retries (10) exceeded for 429 errors. Last retry-after: 30000ms',
            updated_at: Date.now() - 120_000
        }]);

        const result = await TaskManager._runStalledTaskRecovery({ includeRetryableFailed: true });

        expect(result).toMatchObject({ restored: 0, skipped: false });
        expect(mockQueueService.enqueueDownloadTask).not.toHaveBeenCalled();
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
