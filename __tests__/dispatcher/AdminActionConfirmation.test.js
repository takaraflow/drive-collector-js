const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn().mockResolvedValue({})
};
const mockSafeEdit = vi.fn();
const mockSettingsRepository = {
    get: vi.fn(),
    set: vi.fn()
};
const mockApiKeyRepository = {
    getOrCreateToken: vi.fn()
};
const mockSessionManager = {
    start: vi.fn(),
    get: vi.fn(),
    clear: vi.fn()
};
const mockAuthGuard = {
    can: vi.fn(),
    getRole: vi.fn(),
    setRole: vi.fn(),
    removeRole: vi.fn()
};

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: mockAuthGuard
}));
vi.mock('../../src/modules/SessionManager.js', () => ({
    SessionManager: mockSessionManager
}));
vi.mock('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: mockSettingsRepository
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
    getConfig: vi.fn().mockReturnValue({
        ownerId: 'owner',
        nodeEnv: 'test',
        remoteFolder: 'remote-folder'
    }),
    config: { ownerId: 'owner', nodeEnv: 'test', remoteFolder: 'remote-folder' }
}));
vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        getDefaultDrive: vi.fn().mockResolvedValue(null),
        findByUserId: vi.fn().mockResolvedValue([])
    }
}));
vi.mock('../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: { getUserQueueOverview: vi.fn() }
}));
vi.mock('../../src/repositories/ApiKeyRepository.js', () => ({
    ApiKeyRepository: mockApiKeyRepository
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
vi.mock('../../src/services/rclone.js', () => ({
    CloudTool: {}
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
    cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
}));
vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {}
}));
vi.mock('../../src/utils/LocalCache.js', () => ({
    localCache: { del: vi.fn() }
}));
vi.mock('../../src/services/MediaGroupBuffer.js', () => ({
    default: { restore: vi.fn(), add: vi.fn() }
}));
const mockLogger = {
    withModule: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => mockLogger }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => mockLogger
};
vi.mock('../../src/services/logger/index.js', () => ({
    logger: mockLogger
}));

const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher admin action confirmation', () => {
    const callbackEvent = {
        data: Buffer.from('admin_action_execute_nonce123'),
        userId: 'chat-1',
        msgId: 456,
        peer: 'chat-1',
        queryId: 'query-1'
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthGuard.can.mockResolvedValue(true);
        mockAuthGuard.getRole.mockResolvedValue('admin');
        mockSettingsRepository.get.mockResolvedValue('public');
        mockApiKeyRepository.getOrCreateToken.mockResolvedValue('token-123');
    });

    it('should ask for confirmation before changing access mode', async () => {
        await Dispatcher._handleModeSwitchCommand('chat-1', 'admin-1', 'private');

        expect(mockSettingsRepository.set).not.toHaveBeenCalled();
        expect(mockSessionManager.start).toHaveBeenCalledWith('admin-1', 'ADMIN_ACTION_CONFIRM', {
            type: 'access_mode',
            mode: 'private',
            label: '进入维护模式',
            target: '服务访问模式',
            nonce: expect.stringMatching(/^[a-f0-9]{12}$/)
        });
        const buttons = mockClient.sendMessage.mock.calls[0][1].buttons.flat();
        expect(buttons.map(button => button.data.toString())).toEqual([
            expect.stringMatching(/^admin_action_cancel_[a-f0-9]{12}$/),
            expect.stringMatching(/^admin_action_execute_[a-f0-9]{12}$/)
        ]);
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({
                message: expect.stringContaining('确认执行此管理操作'),
                buttons: expect.any(Array),
                parseMode: 'html'
            })
        );
    });

    it('should change access mode only from admin_action_execute session', async () => {
        mockSessionManager.get.mockResolvedValue({
            current_step: 'ADMIN_ACTION_CONFIRM',
            temp_data: JSON.stringify({ type: 'access_mode', mode: 'private', nonce: 'nonce123' })
        });

        await Dispatcher._handleCallback(callbackEvent, { userId: 'admin-1' });

        expect(mockSettingsRepository.set).toHaveBeenCalledWith('access_mode', 'private');
        expect(mockSessionManager.clear).toHaveBeenCalledWith('admin-1');
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'chat-1',
            456,
            expect.stringContaining('访问模式已切换'),
            expect.any(Array),
            'admin-1'
        );
    });

    it('should ask owner for confirmation before granting admin role', async () => {
        await Dispatcher._handleAdminPromotion('chat-1', 'owner', '/pro_admin 2002', true);

        expect(mockAuthGuard.setRole).not.toHaveBeenCalled();
        expect(mockSessionManager.start).toHaveBeenCalledWith('owner', 'ADMIN_ACTION_CONFIRM', {
            type: 'admin_role',
            operation: 'grant',
            targetUid: '2002',
            label: '设置管理员',
            target: '用户 2002',
            nonce: expect.stringMatching(/^[a-f0-9]{12}$/)
        });
    });

    it('should reject stale admin confirmation panels with mismatched nonce', async () => {
        mockSessionManager.get.mockResolvedValue({
            current_step: 'ADMIN_ACTION_CONFIRM',
            temp_data: JSON.stringify({ type: 'access_mode', mode: 'private', nonce: 'newer456' })
        });
        const staleEvent = {
            ...callbackEvent,
            data: Buffer.from('admin_action_execute_older123')
        };

        await Dispatcher._handleCallback(staleEvent, { userId: 'admin-1' });

        expect(mockSettingsRepository.set).not.toHaveBeenCalled();
        expect(mockSessionManager.clear).not.toHaveBeenCalled();
        expect(mockSafeEdit).not.toHaveBeenCalled();
    });

    it('should reject stale admin cancellation panels with mismatched nonce', async () => {
        mockSessionManager.get.mockResolvedValue({
            current_step: 'ADMIN_ACTION_CONFIRM',
            temp_data: JSON.stringify({ type: 'access_mode', mode: 'private', nonce: 'newer456' })
        });
        const staleEvent = {
            ...callbackEvent,
            data: Buffer.from('admin_action_cancel_older123')
        };

        await Dispatcher._handleCallback(staleEvent, { userId: 'admin-1' });

        expect(mockSessionManager.clear).not.toHaveBeenCalled();
        expect(mockSafeEdit).not.toHaveBeenCalled();
    });

    it('should grant admin role only when owner confirms', async () => {
        const result = await Dispatcher._executeAdminAction('owner', {
            type: 'admin_role',
            operation: 'grant',
            targetUid: '2002'
        });

        expect(mockAuthGuard.setRole).toHaveBeenCalledWith('2002', 'admin');
        expect(result).toContain('管理员已设置');
    });

    it('should not let a non-owner grant admin role even through a forged session', async () => {
        const result = await Dispatcher._executeAdminAction('admin-1', {
            type: 'admin_role',
            operation: 'grant',
            targetUid: '2002'
        });

        expect(mockAuthGuard.setRole).not.toHaveBeenCalled();
        expect(result).toContain('无权限');
    });

    it('should ask for confirmation before banning a user', async () => {
        await Dispatcher._handleBanCommand('chat-1', 'admin-1', '/ban 2002', true);

        expect(mockAuthGuard.setRole).not.toHaveBeenCalled();
        expect(mockSessionManager.start).toHaveBeenCalledWith('admin-1', 'ADMIN_ACTION_CONFIRM', {
            type: 'user_ban',
            operation: 'ban',
            targetUid: '2002',
            label: '封禁用户',
            target: '用户 2002',
            nonce: expect.stringMatching(/^[a-f0-9]{12}$/)
        });
    });

    it('should ban user and clear target session only after confirmation', async () => {
        const result = await Dispatcher._executeAdminAction('admin-1', {
            type: 'user_ban',
            operation: 'ban',
            targetUid: '2002'
        });

        expect(mockAuthGuard.setRole).toHaveBeenCalledWith('2002', 'banned');
        expect(mockSessionManager.clear).toHaveBeenCalledWith('2002');
        expect(result).toContain('用户已封禁');
    });

    it('should reject self-ban before confirmation', async () => {
        await Dispatcher._handleBanCommand('chat-1', 'admin-1', '/ban admin-1', true);

        expect(mockSessionManager.start).not.toHaveBeenCalled();
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({ message: expect.stringContaining('不能封禁自己') })
        );
    });

    it('should hide advanced integration help from non-admin users', async () => {
        mockAuthGuard.can.mockResolvedValue(false);

        await Dispatcher._handleMcpCommand('chat-1', 'user-1');

        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({ message: expect.stringContaining('无权限') })
        );
    });

    it('should not create an integration token for non-admin users', async () => {
        mockAuthGuard.can.mockResolvedValue(false);

        await Dispatcher._handleMcpTokenCommand('chat-1', 'user-1');

        expect(mockApiKeyRepository.getOrCreateToken).not.toHaveBeenCalled();
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({ message: expect.stringContaining('无权限') })
        );
    });

    it('should create an integration token only for admin users', async () => {
        await Dispatcher._handleMcpTokenCommand('chat-1', 'admin-1');

        expect(mockApiKeyRepository.getOrCreateToken).toHaveBeenCalledWith('admin-1');
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({
                message: expect.stringContaining('token-123'),
                parseMode: 'html'
            })
        );
        expect(mockClient.sendMessage.mock.calls[0][1].message).toContain('访问密钥');
    });
});
