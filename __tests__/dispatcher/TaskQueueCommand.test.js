// --- Mocks ---
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
};
const mockTaskRepository = {
    getQueueOverview: vi.fn()
};
const mockAuthGuard = {
    can: vi.fn()
};
const mockUIHelper = {
    renderTaskQueue: vi.fn().mockReturnValue('rendered queue report')
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
    updateStatus: vi.fn()
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

// --- Import under test ---
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher /task_queue command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should send placeholder and render queue overview', async () => {
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
