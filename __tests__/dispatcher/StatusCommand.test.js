// --- Mocks ---
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn().mockResolvedValue({}),
};
const mockTaskRepository = {
    getUserQueueOverview: vi.fn(),
    getQueueOverview: vi.fn()
};
const mockUserRepository = {
    normalizeFilter: vi.fn((filter) => filter || 'all')
};
const mockDriveRepository = {
    getDefaultDrive: vi.fn()
};
const mockAuthGuard = {
    can: vi.fn()
};
const mockNetworkDiagnostic = {
    diagnoseAll: vi.fn()
};
const mockIsClientActive = vi.fn(() => true);
const mockSafeEdit = vi.fn();
const mockUIHelper = {
    renderDiagnosisReport: vi.fn(),
    renderTaskQueue: vi.fn()
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
    getClient: vi.fn(() => {
        throw new Error('status should not initialize telegram client');
    }),
    isClientActive: mockIsClientActive
}));
vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: mockTaskRepository
}));
vi.mock('../../src/repositories/UserRepository.js', () => ({
    UserRepository: mockUserRepository
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
    safeEdit: mockSafeEdit,
    escapeHTML: (t) => String(t),
    formatBytes: (bytes) => `${bytes} B`
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
vi.mock('../../src/ui/templates.js', () => ({ UIHelper: mockUIHelper }));
vi.mock('../../src/services/rclone.js', () => ({ CloudTool: {} }));
vi.mock('../../src/repositories/SettingsRepository.js', () => ({ SettingsRepository: {} }));
vi.mock('../../src/repositories/ApiKeyRepository.js', () => ({ ApiKeyRepository: {} }));
vi.mock('../../src/utils/NetworkDiagnostic.js', () => ({ NetworkDiagnostic: mockNetworkDiagnostic }));
vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        getInstanceId: vi.fn(() => 'test-instance'),
        getActiveInstances: vi.fn().mockResolvedValue([]),
        getInstanceCount: vi.fn().mockResolvedValue(1),
        hasLock: vi.fn().mockResolvedValue(true),
        isLeader: true
    }
}));
vi.mock('../../src/services/CacheService.js', () => ({ cache: { getProviderName: vi.fn(() => 'memory'), isFailoverMode: false } }));
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
        mockTaskRepository.getQueueOverview.mockResolvedValue({
            statusCounts: {},
            activeTasks: [],
            userCounts: []
        });
        mockNetworkDiagnostic.diagnoseAll.mockResolvedValue({ services: {} });
        mockUIHelper.renderDiagnosisReport.mockReturnValue('diagnosis report');
        mockUIHelper.renderTaskQueue.mockReturnValue({ text: 'global queue report', buttons: [] });
        mockIsClientActive.mockReturnValue(true);
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
        expect(sent).toContain('📊 <b>我的状态</b>');
        expect(sent).not.toContain('运行时间');
        const buttons = mockClient.sendMessage.mock.calls[0][1].buttons;
        expect(buttons.flat().map(button => button.data.toString())).not.toContain('diagnosis_run');
        expect(buttons.flat().map(button => button.data.toString())).toContain('cancel_confirm_t1');
    });

    it('should show admin-only system diagnostics and shortcuts in general status', async () => {
        mockAuthGuard.can.mockResolvedValue(true);

        await Dispatcher._handleStatusCommand('chat-1', 'admin-1', '/status');

        const sent = mockClient.sendMessage.mock.calls[0][1];
        expect(sent.message).toContain('📊 <b>系统状态</b>');
        expect(sent.message).toContain('管理员诊断信息');
        expect(sent.message).toContain('运行时间');
        const callbackData = sent.buttons.flat().map(button => button.data.toString());
        expect(callbackData).toContain('admin_users_open');
        expect(callbackData).toContain('task_queue_open');
        expect(callbackData).toContain('diagnosis_run');
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
        const callbackData = mockClient.sendMessage.mock.calls[0][1].buttons.flat().map(button => button.data.toString());
        expect(callbackData).toContain('cancel_confirm_t1');
    });

    it('should show an empty personal queue without falling back to global memory state', async () => {
        await Dispatcher._handleStatusCommand('chat-1', 'user-empty', '/status');

        const sent = mockClient.sendMessage.mock.calls[0][1].message;
        expect(sent).toContain('🕒 排队中: 0');
        expect(sent).toContain('🔄 处理中: 0');
        expect(sent).toContain('✅ 当前没有排队或处理中任务。您可以发送文件或链接来创建新任务。');
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

    it('should offer retry action for the latest failed personal task', async () => {
        mockTaskRepository.getUserQueueOverview.mockResolvedValue({
            statusCounts: { failed: 1 },
            activeTasks: [],
            recentTasks: [
                { id: 'failed-1', file_name: 'failed.zip', status: 'failed' }
            ]
        });

        await Dispatcher._handleStatusCommand('chat-1', 'user-1', '/status user');

        const buttons = mockClient.sendMessage.mock.calls[0][1].buttons.flat();
        expect(buttons.map(button => button.data.toString())).toContain('retry_confirm_failed-1');
        expect(buttons.find(button => button.data.toString() === 'retry_confirm_failed-1').text).toContain('重试失败任务');
    });

    it('should edit the current message for help_main callback', async () => {
        const event = {
            data: Buffer.from('help_main'),
            userId: 'chat-1',
            msgId: 456,
            peer: 'chat-1',
            queryId: 'query-1'
        };

        await Dispatcher._handleCallback(event, { userId: 'user-1' });

        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat-1',
            456,
            expect.stringContaining('可以做什么'),
            expect.any(Array),
            'user-1'
        );
    });

    it('should edit the current message for status_general callback', async () => {
        const event = {
            data: Buffer.from('status_general'),
            userId: 'chat-1',
            msgId: 456,
            peer: 'chat-1',
            queryId: 'query-1'
        };

        await Dispatcher._handleCallback(event, { userId: 'user-1' });

        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat-1',
            456,
            expect.stringContaining('我的状态'),
            expect.any(Array),
            'user-1'
        );
    });

    it('should edit the current message for task_queue_open callback', async () => {
        mockAuthGuard.can.mockResolvedValue(true);
        const event = {
            data: Buffer.from('task_queue_open'),
            userId: 'chat-1',
            msgId: 456,
            peer: 'chat-1',
            queryId: 'query-1'
        };

        await Dispatcher._handleCallback(event, { userId: 'admin-1' });

        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith('chat-1', 456, expect.stringContaining('正在查询'), null, 'admin-1');
        expect(mockSafeEdit).toHaveBeenCalledWith('chat-1', 456, 'global queue report', [], 'admin-1');
    });

    it('should read telegram status from side-effect-free local state', async () => {
        mockIsClientActive.mockReturnValue(false);
        const telegramModule = await import('../../src/services/telegram.js');

        const info = await Dispatcher._getInstanceInfo();

        expect(mockIsClientActive).toHaveBeenCalled();
        expect(telegramModule.getClient).not.toHaveBeenCalled();
        expect(info).toEqual(expect.objectContaining({
            tgActive: false,
            isTgLeader: true,
            currentInstanceId: 'test-instance'
        }));
    });

    it('should edit the current message for diagnosis_run callback', async () => {
        mockAuthGuard.can.mockResolvedValue(true);
        const event = {
            data: Buffer.from('diagnosis_run'),
            userId: 'chat-1',
            msgId: 456,
            peer: 'chat-1',
            queryId: 'query-1'
        };

        await Dispatcher._handleCallback(event, { userId: 'admin-1' });

        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith('chat-1', 456, expect.stringContaining('正在执行系统诊断'), null, 'admin-1');
        expect(mockSafeEdit).toHaveBeenCalledWith('chat-1', 456, 'diagnosis report', expect.any(Array), 'admin-1');
        expect(mockUIHelper.renderDiagnosisReport).toHaveBeenCalledWith(expect.objectContaining({
            systemResources: expect.objectContaining({
                rss: expect.any(String),
                heap: expect.any(String),
                external: expect.any(String),
                uptime: expect.any(String)
            })
        }));
    });
});
