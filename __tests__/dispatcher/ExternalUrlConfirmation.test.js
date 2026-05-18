const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn().mockResolvedValue({})
};
const mockAuthGuard = {
    can: vi.fn(),
    getRole: vi.fn().mockResolvedValue('admin')
};
const mockSessionManager = {
    start: vi.fn(),
    get: vi.fn(),
    clear: vi.fn()
};
const mockTaskManager = {
    addExternalUrlTask: vi.fn().mockResolvedValue('task-1')
};
const mockDriveRepository = {
    getDefaultDrive: vi.fn().mockResolvedValue({ id: 'drive-1', type: 'mega' }),
    findByUserId: vi.fn().mockResolvedValue([{ id: 'drive-1', type: 'mega' }])
};
const mockProbeExternalUrl = vi.fn();
const mockSafeEdit = vi.fn();

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock('../../src/modules/AuthGuard.js', () => ({ AuthGuard: mockAuthGuard }));
vi.mock('../../src/modules/SessionManager.js', () => ({ SessionManager: mockSessionManager }));
vi.mock('../../src/processor/TaskManager.js', () => ({ TaskManager: mockTaskManager }));
vi.mock('../../src/repositories/DriveRepository.js', () => ({ DriveRepository: mockDriveRepository }));
vi.mock('../../src/repositories/SettingsRepository.js', () => ({ SettingsRepository: { get: vi.fn().mockResolvedValue('public') } }));
vi.mock('../../src/repositories/TaskRepository.js', () => ({ TaskRepository: {} }));
vi.mock('../../src/repositories/ApiKeyRepository.js', () => ({ ApiKeyRepository: {} }));
vi.mock('../../src/processor/LinkParser.js', () => ({ LinkParser: { parse: vi.fn().mockResolvedValue(null) } }));
vi.mock('../../src/processor/ExternalUrlPolicy.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        probeExternalUrl: mockProbeExternalUrl
    };
});
vi.mock('../../src/utils/common.js', () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (value) => String(value),
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
        remoteFolder: 'remote',
        externalDownload: { timeoutMs: 30000 }
    })
}));
vi.mock('../../src/modules/DriveConfigFlow.js', () => ({ DriveConfigFlow: {} }));
vi.mock('../../src/ui/templates.js', () => ({ UIHelper: {} }));
vi.mock('../../src/services/rclone.js', () => ({ CloudTool: {} }));
vi.mock('../../src/utils/NetworkDiagnostic.js', () => ({ NetworkDiagnostic: {} }));
vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: { getInstanceId: vi.fn(() => 'i1'), hasLock: vi.fn().mockResolvedValue(true), isLeader: true }
}));
vi.mock('../../src/services/CacheService.js', () => ({ cache: {} }));
vi.mock('../../src/services/QueueService.js', () => ({ queueService: {} }));
vi.mock('../../src/utils/LocalCache.js', () => ({ localCache: {} }));
vi.mock('../../src/services/MediaGroupBuffer.js', () => ({ default: { restore: vi.fn(), add: vi.fn() } }));
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

const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher external URL confirmation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthGuard.can.mockResolvedValue(true);
        mockProbeExternalUrl.mockResolvedValue({
            url: 'https://files.example.com/video.mp4?token=secret',
            finalUrl: 'https://files.example.com/video.mp4?token=secret',
            displayUrl: 'https://files.example.com/video.mp4',
            fileName: 'video.mp4',
            fileSize: 2048,
            contentType: 'video/mp4'
        });
    });

    it('shows a confirmation card for admin HTTP links and does not enqueue immediately', async () => {
        const handled = await Dispatcher._handleLinks('chat-1', 'admin-1', 'https://files.example.com/video.mp4?token=secret', { id: 'drive-1' });

        expect(handled).toBe(true);
        expect(mockSessionManager.start).toHaveBeenCalledWith(
            'admin-1',
            'EXTERNAL_URL_CONFIRM',
            expect.objectContaining({
                nonce: expect.stringMatching(/^[a-f0-9]{12}$/),
                source: expect.objectContaining({ fileName: 'video.mp4' })
            })
        );
        expect(mockTaskManager.addExternalUrlTask).not.toHaveBeenCalled();
        const buttons = mockClient.sendMessage.mock.calls[0][1].buttons.flat().map(button => button.data.toString());
        expect(buttons).toEqual([
            expect.stringMatching(/^external_url_cancel_[a-f0-9]{12}$/),
            expect.stringMatching(/^external_url_execute_[a-f0-9]{12}$/)
        ]);
    });

    it('rejects non-admin external HTTP links', async () => {
        mockAuthGuard.can.mockResolvedValue(false);

        const handled = await Dispatcher._handleLinks('chat-1', 'user-1', 'https://files.example.com/video.mp4', { id: 'drive-1' });

        expect(handled).toBe(true);
        expect(mockProbeExternalUrl).not.toHaveBeenCalled();
        expect(mockSessionManager.start).not.toHaveBeenCalled();
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({ message: expect.stringContaining('仅管理员') })
        );
    });

    it('rejects P2P links before probing', async () => {
        const handled = await Dispatcher._handleLinks('chat-1', 'admin-1', 'magnet:?xt=urn:btih:abc', { id: 'drive-1' });

        expect(handled).toBe(true);
        expect(mockProbeExternalUrl).not.toHaveBeenCalled();
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            'chat-1',
            expect.objectContaining({ message: expect.stringContaining('暂不支持') })
        );
    });

    it('executes only the matching confirmation nonce', async () => {
        const callbackEvent = {
            data: Buffer.from('external_url_execute_nonce123'),
            userId: 'chat-1',
            msgId: 456,
            peer: 'chat-1',
            queryId: 'query-1'
        };
        const source = {
            url: 'https://files.example.com/video.mp4?token=secret',
            displayUrl: 'https://files.example.com/video.mp4',
            fileName: 'video.mp4',
            fileSize: 2048
        };
        mockSessionManager.get.mockResolvedValue({
            current_step: 'EXTERNAL_URL_CONFIRM',
            temp_data: JSON.stringify({ nonce: 'nonce123', source, chatId: 'chat-1' })
        });

        await Dispatcher._handleCallback(callbackEvent, { userId: 'admin-1' });

        expect(mockTaskManager.addExternalUrlTask).toHaveBeenCalledWith('chat-1', source, 'admin-1');
        expect(mockSessionManager.clear).toHaveBeenCalledWith('admin-1');
        expect(mockSafeEdit).toHaveBeenCalledWith('chat-1', 456, expect.any(String), expect.any(Array), 'admin-1');
    });

    it('keeps group confirmation bound to the original callback peer', async () => {
        const callbackEvent = {
            data: Buffer.from('external_url_execute_nonce123'),
            userId: 'admin-1',
            msgId: 456,
            peer: { chatId: 'group-1' },
            queryId: 'query-1'
        };
        const source = {
            url: 'https://files.example.com/video.mp4?token=secret',
            displayUrl: 'https://files.example.com/video.mp4',
            fileName: 'video.mp4',
            fileSize: 2048
        };
        mockSessionManager.get.mockResolvedValue({
            current_step: 'EXTERNAL_URL_CONFIRM',
            temp_data: JSON.stringify({ nonce: 'nonce123', source, chatId: 'group-1' })
        });

        await Dispatcher._handleCallback(callbackEvent, { userId: 'admin-1' });

        expect(mockTaskManager.addExternalUrlTask).toHaveBeenCalledWith({ chatId: 'group-1' }, source, 'admin-1');
        expect(mockSafeEdit).toHaveBeenCalledWith({ chatId: 'group-1' }, 456, expect.any(String), expect.any(Array), 'admin-1');
    });
});
