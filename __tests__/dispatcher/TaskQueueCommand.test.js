// --- Mocks ---
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn().mockResolvedValue({}),
};
const mockTaskRepository = {
    getQueueOverview: vi.fn(),
    getTasksByStatus: vi.fn()
};
const mockAuthGuard = {
    can: vi.fn()
};
const mockUIHelper = {
    renderTaskQueue: vi.fn().mockReturnValue({ text: 'rendered queue report', buttons: [] }),
    renderTaskQueueDetail: vi.fn().mockReturnValue({ text: 'rendered detail', buttons: [] })
};
const mockSafeEdit = vi.fn();

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: mockTaskRepository
}));
vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: mockAuthGuard
}));
vi.mock('../../src/ui/templates.js', () => ({
    UIHelper: mockUIHelper
}));
vi.mock('../../src/utils/common.js', () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (t) => t,
    getMediaInfo: vi.fn(),
    updateStatus: vi.fn(),
    formatBytes: (b) => `${b}B`
}));
vi.mock('../../src/config/index.js', () => ({
    getConfig: vi.fn().mockReturnValue({ ownerId: '999' }),
    config: { ownerId: '999' }
}));
const mockPriority = { UI: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 };
vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: mockPriority
}));
vi.mock('../../src/services/CacheService.js', () => ({
    cache: { get: vi.fn(), set: vi.fn() }
}));
vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {}
}));
const mockLogger = {
    withModule: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn()
};
vi.mock('../../src/services/logger/index.js', () => ({
    default: mockLogger,
    logger: mockLogger,
    setInstanceIdProvider: vi.fn(),
    enableTelegramConsoleProxy: vi.fn(),
    disableTelegramConsoleProxy: vi.fn(),
    flushLogBuffer: vi.fn(),
    createLogger: vi.fn(() => mockLogger),
    LoggerService: vi.fn()
}));

const mockTaskManager = {
    retryTask: vi.fn(),
    cancelTask: vi.fn(),
    cancelTasksByMsgId: vi.fn(),
};
vi.mock('../../src/processor/TaskManager.js', () => ({
    TaskManager: mockTaskManager
}));

// --- Import under test ---
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher /task_queue command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should send placeholder and render queue overview with buttons', async () => {
        const mockData = {
            statusCounts: { queued: 5, downloading: 2, completed: 100 },
            activeTasks: [
                { id: 't1', user_id: 'u1', file_name: 'a.mp4', status: 'downloading', updated_at: Date.now() }
            ],
            userCounts: [{ user_id: 'u1', count: 3 }]
        };
        mockTaskRepository.getQueueOverview.mockResolvedValue(mockData);

        await Dispatcher._handleTaskQueueCommand('chat123', '123');

        // Wait for async IIFE to complete (dynamic import + repository call)
        await new Promise(r => setTimeout(r, 50));

        // Should send placeholder message
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat123',
            expect.objectContaining({ message: expect.stringContaining('正在查询') })
        );
        // Should call repository
        expect(mockTaskRepository.getQueueOverview).toHaveBeenCalledWith(10);
        // Should render via UIHelper
        expect(mockUIHelper.renderTaskQueue).toHaveBeenCalledWith(mockData);
        // Should safeEdit with text and buttons
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat123', 123, 'rendered queue report', [], '123'
        );
    });

    it('should handle database errors gracefully', async () => {
        mockTaskRepository.getQueueOverview.mockRejectedValue(new Error('DB connection failed'));

        await Dispatcher._handleTaskQueueCommand('chat123', '123');

        // Wait for async IIFE to complete
        await new Promise(r => setTimeout(r, 50));

        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat123', 123,
            expect.stringContaining('❌ 查询任务队列失败: DB connection failed'),
            null, '123'
        );
    });

    it('should use custom limit when provided', async () => {
        mockTaskRepository.getQueueOverview.mockResolvedValue({
            statusCounts: {}, activeTasks: [], userCounts: []
        });

        await Dispatcher._handleTaskQueueCommand('chat123', '123');

        // Wait for async IIFE to complete (dynamic import + repository call)
        await new Promise(r => setTimeout(r, 50));

        expect(mockTaskRepository.getQueueOverview).toHaveBeenCalledWith(10);
    });
});

describe('Dispatcher /task_queue callback', () => {
    const createCallbackEvent = (data) => ({
        data: Buffer.from(data),
        userId: '123',
        msgId: 456,
        peer: 'chat123',
        queryId: 'query789'
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should handle tq_back callback to return to overview', async () => {
        const overviewData = { statusCounts: {}, activeTasks: [], userCounts: [] };
        mockTaskRepository.getQueueOverview.mockResolvedValue(overviewData);

        await Dispatcher._handleTaskQueueCallback(
            createCallbackEvent('tq_back'), 'tq_back', '123', vi.fn()
        );

        await new Promise(r => setTimeout(r, 50));

        expect(mockTaskRepository.getQueueOverview).toHaveBeenCalledWith(10);
        expect(mockUIHelper.renderTaskQueue).toHaveBeenCalledWith(overviewData);
        expect(mockSafeEdit).toHaveBeenCalled();
    });

    it('should handle tq_failed_0 callback to show failed tasks', async () => {
        const detailData = {
            tasks: [{ id: 't1', user_id: 'u1', file_name: 'a.mp4', error_msg: 'timeout', status: 'failed' }],
            total: 1, page: 0, pageSize: 10, totalPages: 1
        };
        mockTaskRepository.getTasksByStatus.mockResolvedValue(detailData);

        await Dispatcher._handleTaskQueueCallback(
            createCallbackEvent('tq_failed_0'), 'tq_failed_0', '123', vi.fn()
        );

        await new Promise(r => setTimeout(r, 50));

        expect(mockTaskRepository.getTasksByStatus).toHaveBeenCalledWith('failed', 0, 8);
        expect(mockUIHelper.renderTaskQueueDetail).toHaveBeenCalledWith('failed', detailData);
    });

    it('should handle tq_refresh_completed_1 callback', async () => {
        const detailData = { tasks: [], total: 0, page: 1, pageSize: 10, totalPages: 0 };
        mockTaskRepository.getTasksByStatus.mockResolvedValue(detailData);

        await Dispatcher._handleTaskQueueCallback(
            createCallbackEvent('tq_refresh_completed_1'), 'tq_refresh_completed_1', '123', vi.fn()
        );

        await new Promise(r => setTimeout(r, 50));

        expect(mockTaskRepository.getTasksByStatus).toHaveBeenCalledWith('completed', 1, 8);
    });

    it('should handle callback errors gracefully', async () => {
        mockTaskRepository.getTasksByStatus.mockRejectedValue(new Error('DB error'));
        const answerMock = vi.fn();

        await Dispatcher._handleTaskQueueCallback(
            createCallbackEvent('tq_queued_0'), 'tq_queued_0', '123', answerMock
        );

        await new Promise(r => setTimeout(r, 50));

        expect(answerMock).toHaveBeenCalledWith(expect.stringContaining('DB error'));
    });
});

describe('Dispatcher retry_ callback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should call TaskManager.retryTask on retry_ callback', async () => {
        mockTaskManager.retryTask.mockResolvedValue({ success: true, statusCode: 200, message: "Task re-enqueued" });

        const event = {
            data: Buffer.from('retry_task-123'),
            userId: '123',
            peer: 'chat123',
            queryId: 'query789'
        };

        await Dispatcher._handleCallback(event, { userId: '123' });

        expect(mockTaskManager.retryTask).toHaveBeenCalledWith('task-123', '123');
    });

    it('should invoke callback answer on retry success', async () => {
        mockTaskManager.retryTask.mockResolvedValue({ success: true, statusCode: 200, message: "Task re-enqueued" });

        const event = {
            data: Buffer.from('retry_task-456'),
            userId: '123',
            peer: 'chat123',
            queryId: 'query789'
        };

        await Dispatcher._handleCallback(event, { userId: '123' });

        expect(mockClient.invoke).toHaveBeenCalled();
    });

    it('should invoke callback answer on retry failure', async () => {
        mockTaskManager.retryTask.mockResolvedValue({ success: false, message: "Task already completed" });

        const event = {
            data: Buffer.from('retry_task-456'),
            userId: '123',
            peer: 'chat123',
            queryId: 'query789'
        };

        await Dispatcher._handleCallback(event, { userId: '123' });

        expect(mockTaskManager.retryTask).toHaveBeenCalledWith('task-456', '123');
        expect(mockClient.invoke).toHaveBeenCalled();
    });

    it('should show permission denied on unauthorized retry', async () => {
        mockTaskManager.retryTask.mockResolvedValue({ success: false, statusCode: 403, message: "Permission denied" });

        const event = {
            data: Buffer.from('retry_task-789'),
            userId: '456',
            peer: 'chat123',
            queryId: 'query789'
        };

        await Dispatcher._handleCallback(event, { userId: '456' });

        expect(mockTaskManager.retryTask).toHaveBeenCalledWith('task-789', '456');
        expect(mockClient.invoke).toHaveBeenCalled();
    });
});
