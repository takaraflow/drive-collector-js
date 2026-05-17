const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn().mockResolvedValue({})
};
const mockSafeEdit = vi.fn();
const mockDriveRepository = {
    findByUserId: vi.fn(),
    getDefaultDrive: vi.fn(),
    updateRemoteFolder: vi.fn()
};
const mockSessionManager = {
    start: vi.fn(),
    clear: vi.fn(),
    get: vi.fn()
};
const mockAuthGuard = {
    getRole: vi.fn().mockResolvedValue('user'),
    can: vi.fn().mockResolvedValue(true)
};

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: mockDriveRepository
}));
vi.mock('../../src/modules/SessionManager.js', () => ({
    SessionManager: mockSessionManager
}));
vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: mockAuthGuard
}));
vi.mock('../../src/config/index.js', () => ({
    getConfig: vi.fn().mockReturnValue({
        ownerId: 'owner',
        nodeEnv: 'test',
        remoteFolder: 'default-folder'
    }),
    config: { ownerId: 'owner', nodeEnv: 'test', remoteFolder: 'default-folder' }
}));
vi.mock('../../src/utils/common.js', () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (t) => String(t)
}));
vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 10 }
}));
vi.mock('../../src/services/rclone.js', () => ({
    CloudTool: {
        _validatePath: vi.fn(() => true),
        isLoading: vi.fn(() => false),
        listRemoteFiles: vi.fn()
    }
}));
vi.mock('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: { get: vi.fn(), set: vi.fn() }
}));
vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: {}
}));
vi.mock('../../src/repositories/ApiKeyRepository.js', () => ({
    ApiKeyRepository: {}
}));
vi.mock('../../src/processor/TaskManager.js', () => ({
    TaskManager: {}
}));
vi.mock('../../src/processor/LinkParser.js', () => ({
    LinkParser: {}
}));
vi.mock('../../src/modules/DriveConfigFlow.js', () => ({
    DriveConfigFlow: {}
}));
vi.mock('../../src/ui/templates.js', () => ({
    UIHelper: {}
}));
vi.mock('../../src/utils/NetworkDiagnostic.js', () => ({
    NetworkDiagnostic: {}
}));
vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        getInstanceId: vi.fn(() => 'test-instance'),
        hasLock: vi.fn().mockResolvedValue(true),
        isLeader: true
    }
}));
vi.mock('../../src/services/CacheService.js', () => ({
    cache: { delete: vi.fn() }
}));
vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {}
}));
vi.mock('../../src/utils/LocalCache.js', () => ({
    localCache: { del: vi.fn() }
}));
vi.mock('../../src/services/MediaGroupBuffer.js', () => ({
    default: { restore: vi.fn() }
}));

const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher remote folder callbacks', () => {
    const event = {
        userId: 'chat-1',
        msgId: 456,
        peer: 'chat-1',
        queryId: 'query-1',
        data: Buffer.from('remote_folder_menu')
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockDriveRepository.getDefaultDrive.mockResolvedValue({
            id: 'drive-1',
            type: 'mega',
            remote_folder: '/Movies'
        });
    });

    it('should edit the current message when returning to the remote folder menu', async () => {
        const answer = vi.fn();

        await Dispatcher._handleRemoteFolderCallback(event, 'user-1', answer);

        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat-1',
            456,
            expect.stringContaining('保存目录'),
            expect.any(Array),
            'user-1'
        );
        expect(mockSafeEdit.mock.calls[0][2]).toContain('/Movies');
        expect(mockSafeEdit.mock.calls[0][2]).toContain('点击“设置保存目录”后发送新目录');
        expect(answer).toHaveBeenCalledWith('');
    });

    it('should route remote_folder_menu through the public callback handler without sending a new message', async () => {
        await Dispatcher._handleCallback(event, { userId: 'user-1' });

        expect(mockClient.sendMessage).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat-1',
            456,
            expect.stringContaining('保存目录'),
            expect.any(Array),
            'user-1'
        );
        expect(mockSafeEdit.mock.calls[0][2]).toContain('/Movies');
        expect(mockClient.invoke).toHaveBeenCalled();
    });
});
