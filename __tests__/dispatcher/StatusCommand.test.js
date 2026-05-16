// --- Mocks ---
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
};
const mockTaskRepository = {
    getUserQueueOverview: vi.fn()
};
const mockDriveRepository = {
    getDefaultDrive: vi.fn()
};
const mockAuthGuard = {
    can: vi.fn()
};
const mockTaskManager = {
    getWaitingCount: vi.fn(() => 99),
    getProcessingCount: vi.fn(() => 88),
    currentTask: { fileName: 'wrong-memory-task.mp4' },
    addTask: vi.fn(),
    addBatchTasks: vi.fn(),
    cancelTask: vi.fn(),
    cancelTasksByMsgId: vi.fn(),
    retryTask: vi.fn()
};

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: mockTaskRepository
}));
vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: mockDriveRepository
}));
vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: mockAuthGuard
}));
vi.mock('../../src/processor/TaskManager.js', () => ({
    TaskManager: mockTaskManager
}));
vi.mock('../../src/utils/common.js', () => ({
    safeEdit: vi.fn(),
    escapeHTML: (t) => String(t)
}));
vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 10 }
}));
vi.mock('../../src/config/index.js', () => ({
    getConfig: vi.fn().mockReturnValue({ ownerId: 'owner', nodeEnv: 'test' }),
    config: { ownerId: 'owner' }
}));
vi.mock('../../src/modules/SessionManager.js', () => ({ SessionManager: {} }));
vi.mock('../../src/modules/DriveConfigFlow.js', () => ({ DriveConfigFlow: {} }));
vi.mock('../../src/processor/LinkParser.js', () => ({ LinkParser: {} }));
vi.mock('../../src/ui/templates.js', () => ({ UIHelper: {} }));
vi.mock('../../src/services/rclone.js', () => ({ CloudTool: {} }));
vi.mock('../../src/repositories/SettingsRepository.js', () => ({ SettingsRepository: {} }));
vi.mock('../../src/repositories/ApiKeyRepository.js', () => ({ ApiKeyRepository: {} }));
vi.mock('../../src/utils/NetworkDiagnostic.js', () => ({ NetworkDiagnostic: {} }));
vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        getInstanceId: vi.fn(() => 'test-instance'),
        hasLock: vi.fn().mockResolvedValue(true),
        isLeader: true
    }
}));
vi.mock('../../src/services/CacheService.js', () => ({ cache: {} }));
vi.mock('../../src/services/QueueService.js', () => ({ queueService: {} }));
vi.mock('../../src/utils/LocalCache.js', () => ({ localCache: {} }));
vi.mock('../../src/services/MediaGroupBuffer.js', () => ({ default: { restore: vi.fn() } }));

const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher /status command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthGuard.can.mockResolvedValue(false);
        mockDriveRepository.getDefaultDrive.mockResolvedValue({ type: 'mega' });
        mockTaskRepository.getUserQueueOverview.mockResolvedValue({
            statusCounts: {},
            activeTasks: [],
            recentTasks: []
        });
    });

    it('should render the current user queue from D1 instead of TaskManager memory counts', async () => {
        mockTaskRepository.getUserQueueOverview.mockResolvedValue({
            statusCounts: {
                queued: 2,
                downloading: 1,
                downloaded: 1,
                uploading: 1,
                completed: 9
            },
            activeTasks: [
                { id: 't1', file_name: 'queued-user-file.mp4', status: 'queued' },
                { id: 't2', file_name: 'uploading-user-file.mp4', status: 'uploading' }
            ],
            recentTasks: []
        });

        await Dispatcher._handleStatusCommand('chat-1', 'user-1', '/status');

        expect(mockTaskRepository.getUserQueueOverview).toHaveBeenCalledWith('user-1', 10);
        expect(mockTaskManager.getWaitingCount).not.toHaveBeenCalled();
        expect(mockTaskManager.getProcessingCount).not.toHaveBeenCalled();

        const sent = mockClient.sendMessage.mock.calls[0][1].message;
        expect(sent).toContain('📦 您的任务队列');
        expect(sent).toContain('🕒 排队中: 2');
        expect(sent).toContain('🔄 处理中: 3');
        expect(sent).toContain('queued-user-file.mp4');
        expect(sent).toContain('uploading-user-file.mp4');
        expect(sent).not.toContain('99');
        expect(sent).not.toContain('88');
        expect(sent).not.toContain('wrong-memory-task.mp4');
    });

    it('should render /status queue as a personal queue view', async () => {
        mockTaskRepository.getUserQueueOverview.mockResolvedValue({
            statusCounts: { queued: 1 },
            activeTasks: [{ id: 't1', file_name: 'only-current-user.txt', status: 'queued' }],
            recentTasks: []
        });

        await Dispatcher._handleStatusCommand('chat-1', 'user-42', '/status queue');

        expect(mockTaskRepository.getUserQueueOverview).toHaveBeenCalledWith('user-42', 10);
        const sent = mockClient.sendMessage.mock.calls[0][1].message;
        expect(sent).toContain('🕒 排队中: 1');
        expect(sent).toContain('only-current-user.txt');
    });

    it('should show an empty personal queue without falling back to global memory state', async () => {
        await Dispatcher._handleStatusCommand('chat-1', 'user-empty', '/status');

        const sent = mockClient.sendMessage.mock.calls[0][1].message;
        expect(sent).toContain('🕒 排队中: 0');
        expect(sent).toContain('🔄 处理中: 0');
        expect(sent).toContain('✅ 当前没有排队或处理中任务。');
        expect(sent).not.toContain('wrong-memory-task.mp4');
    });

    it('should render /status user history with the same status vocabulary', async () => {
        mockTaskRepository.getUserQueueOverview.mockResolvedValue({
            statusCounts: { queued: 1 },
            activeTasks: [{ id: 't1', file_name: 'queued-now.zip', status: 'queued' }],
            recentTasks: [
                { id: 't1', file_name: 'queued-now.zip', status: 'queued' },
                { id: 't2', file_name: 'done-before.zip', status: 'completed' }
            ]
        });

        await Dispatcher._handleStatusCommand('chat-1', 'user-1', '/status user');

        const sent = mockClient.sendMessage.mock.calls[0][1].message;
        expect(sent).toContain('👤 您的任务历史');
        expect(sent).toContain('queued-now.zip</code> (排队中)');
        expect(sent).toContain('done-before.zip</code> (完成)');
    });
});
