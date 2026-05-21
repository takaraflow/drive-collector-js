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
    client: {
        getMessages: vi.fn(),
        sendMessage: vi.fn(),
        editMessage: vi.fn(),
        connected: true,
    }
}));

vi.mock('../../src/services/CacheService.js', () => ({
    cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
}));

vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: {
        updateStatus: vi.fn(),
        transitionStatus: vi.fn(),
        findById: vi.fn(),
        findByMsgId: vi.fn().mockResolvedValue([]),
    }
}));

vi.mock('../../src/services/d1.js', () => ({
    d1: { prepare: vi.fn().mockReturnThis(), bind: vi.fn().mockReturnThis(), run: vi.fn(), all: vi.fn(), first: vi.fn(), batch: vi.fn() }
}));

vi.mock('../../src/services/logger/index.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withModule: vi.fn().mockReturnThis(), withContext: vi.fn().mockReturnThis() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withModule: vi.fn().mockReturnThis(), withContext: vi.fn().mockReturnThis() }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        hasLock: vi.fn().mockResolvedValue(true),
        getLockLease: vi.fn().mockResolvedValue({ instanceId: 'test-instance', leaseId: 'lease-test' }),
        isLockLeaseCurrent: vi.fn().mockResolvedValue(true),
        releaseTaskLock: vi.fn().mockResolvedValue(true),
        acquireTaskLock: vi.fn().mockResolvedValue(true),
    }
}));

vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        enqueueDownloadTask: vi.fn().mockResolvedValue({ success: true }),
        enqueueUploadTask: vi.fn().mockResolvedValue({ success: true }),
    }
}));

vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: { can: vi.fn().mockResolvedValue(false) }
}));

vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 20, HIGH: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 }
}));

vi.mock('../../src/services/rclone.js', () => ({
    CloudTool: { getRemoteFileInfo: vi.fn(), uploadFile: vi.fn(), listRemoteFiles: vi.fn() }
}));

vi.mock('../../src/services/oss.js', () => ({
    ossService: { upload: vi.fn() }
}));

vi.mock('../../src/ui/templates.js', () => ({
    UIHelper: { renderProgress: vi.fn(), renderTaskQueue: vi.fn(), renderTaskQueueDetail: vi.fn() }
}));

vi.mock('../../src/utils/common.js', () => ({
    getMediaInfo: vi.fn(),
    updateStatus: vi.fn(),
    escapeHTML: (t) => t,
    safeEdit: vi.fn(),
    formatBytes: (b) => `${b}B`
}));

vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: { can: vi.fn() }
}));

vi.mock('../../src/services/StreamTransferService.js', () => ({
    streamTransferService: {}
}));

const { TaskManager } = await import('../../src/processor/TaskManager.js');

describe('TaskManager - Retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should retry a failed task via QStash', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        const { queueService } = await import('../../src/services/QueueService.js');
        const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
        TaskRepository.transitionStatus.mockResolvedValue({
            changed: true,
            blocked: false,
            toStatus: 'queued',
            queueAttempt: 'queued:1700000000000'
        });

        TaskRepository.findById.mockResolvedValue({
            id: 'task-123', user_id: 'u1', chat_id: 'c1', msg_id: 'm1',
            source_msg_id: 100, file_name: 'test.mp4', status: 'failed'
        });

        const result = await TaskManager.retryTask('task-123');

        expect(instanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('task-123');
        expect(queueService.enqueueDownloadTask).toHaveBeenCalledWith('task-123', expect.objectContaining({
            _meta: expect.objectContaining({
                triggerSource: 'manual-retry',
                queueAttempt: 'queued:1700000000000'
            })
        }));
        expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
            'task-123',
            'retry',
            null,
            expect.objectContaining({ source: 'retryTask' })
        );
        expect(result).toEqual({ success: true, statusCode: 200, message: "Task re-enqueued" });
    });

    it('should not fetch Telegram message or check local files', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        const { client } = await import('../../src/services/telegram.js');
        TaskRepository.transitionStatus.mockResolvedValue({ changed: true, blocked: false, toStatus: 'queued' });

        TaskRepository.findById.mockResolvedValue({
            id: 'task-123', user_id: 'u1', chat_id: 'c1', msg_id: 'm1',
            source_msg_id: 100, file_name: 'test.mp4', status: 'failed'
        });

        await TaskManager.retryTask('task-123');

        expect(client.getMessages).not.toHaveBeenCalled();
    });

    it('should reject completed tasks', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.findById.mockResolvedValue({ id: 't1', status: 'completed' });

        const result = await TaskManager.retryTask('t1');
        expect(result).toEqual({ success: false, statusCode: 400, message: "Task already completed" });
    });

    it('should reject cancelled tasks', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.findById.mockResolvedValue({ id: 't1', status: 'cancelled' });

        const result = await TaskManager.retryTask('t1');
        expect(result).toEqual({ success: false, statusCode: 400, message: "Task is cancelled" });
    });

    it('should reject missing taskId', async () => {
        const result = await TaskManager.retryTask(null);
        expect(result).toEqual({ success: false, statusCode: 400, message: "Task ID is required" });
    });

    it('should reject non-existent task', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.findById.mockResolvedValue(null);

        const result = await TaskManager.retryTask('nonexistent');
        expect(result).toEqual({ success: false, statusCode: 404, message: "Task not found" });
    });

    it('should handle D1 errors gracefully', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.findById.mockRejectedValue(new Error('DB connection failed'));

        const result = await TaskManager.retryTask('task-123');
        expect(result).toEqual({ success: false, statusCode: 500, message: "DB connection failed" });
    });

    it('should reject when user is not owner and lacks permission', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.findById.mockResolvedValue({
            id: 'task-123', user_id: 'owner-1', status: 'failed'
        });

        const result = await TaskManager.retryTask('task-123', 'other-user');
        expect(result).toEqual({ success: false, statusCode: 403, message: "Permission denied" });
    });

    it('should allow retry when user is owner', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.transitionStatus.mockResolvedValue({ changed: true, blocked: false, toStatus: 'queued' });
        TaskRepository.findById.mockResolvedValue({
            id: 'task-123', user_id: 'owner-1', status: 'failed'
        });

        const result = await TaskManager.retryTask('task-123', 'owner-1');
        expect(result.success).toBe(true);
    });

    it('should allow retry for already queued tasks (stuck recovery)', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        TaskRepository.transitionStatus.mockResolvedValue({
            changed: true,
            blocked: false,
            toStatus: 'queued',
            queueAttempt: 'queued:1700000000001'
        });
        TaskRepository.findById.mockResolvedValue({
            id: 'task-123', user_id: 'u1', status: 'queued'
        });

        const result = await TaskManager.retryTask('task-123');
        expect(result).toEqual({ success: true, statusCode: 200, message: "Task re-enqueued" });
        const { queueService } = await import('../../src/services/QueueService.js');
        expect(queueService.enqueueDownloadTask).toHaveBeenCalledWith('task-123', expect.objectContaining({
            _meta: expect.objectContaining({ queueAttempt: 'queued:1700000000001' })
        }));
    });

    it('should reject manual retry for active tasks instead of re-enqueueing', async () => {
        const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
        const { queueService } = await import('../../src/services/QueueService.js');
        const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
        TaskRepository.findById.mockResolvedValue({
            id: 'task-active',
            user_id: 'u1',
            status: 'downloading'
        });

        const result = await TaskManager.retryTask('task-active');

        expect(result).toEqual({
            success: false,
            statusCode: 409,
            message: 'Task is downloading; manual retry is only allowed for failed or queued tasks'
        });
        expect(instanceCoordinator.releaseTaskLock).not.toHaveBeenCalled();
        expect(TaskRepository.transitionStatus).not.toHaveBeenCalled();
        expect(queueService.enqueueDownloadTask).not.toHaveBeenCalled();
    });
});
