import { jest } from '@jest/globals';

// --- Mocks ---
const mockSendMessage = jest.fn().mockResolvedValue({ id: 123 });
const mockInvoke = jest.fn().mockResolvedValue({});
const mockFindByUserId = jest.fn();
const mockUpdateRemoteFolder = jest.fn();
const mockSessionStart = jest.fn();
const mockSessionGet = jest.fn();
const mockSessionClear = jest.fn();
const mockSettingsGet = jest.fn();

await jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    client: {
        sendMessage: mockSendMessage,
        invoke: mockInvoke
    },
    isClientActive: () => true,
    getUpdateHealth: () => ({ lastUpdate: Date.now(), timeSince: 0 })
}));

await jest.unstable_mockModule('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        findByUserId: mockFindByUserId,
        findById: jest.fn().mockResolvedValue({ id: 'drive1', type: 'mega', remote_folder: null }),
        updateRemoteFolder: mockUpdateRemoteFolder
    }
}));

await jest.unstable_mockModule('../../src/modules/SessionManager.js', () => ({
    SessionManager: {
        start: mockSessionStart,
        get: mockSessionGet,
        clear: mockSessionClear
    }
}));

await jest.unstable_mockModule('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: mockSettingsGet,
        set: jest.fn()
    }
}));

await jest.unstable_mockModule('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: {
        getRole: jest.fn().mockResolvedValue('user'),
        can: jest.fn().mockResolvedValue(true)
    }
}));

await jest.unstable_mockModule('../../src/utils/limiter.js', () => ({
    runBotTask: jest.fn((fn) => fn()),
    runBotTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoTask: jest.fn((fn) => fn()),
    runMtprotoTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoFileTask: jest.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: jest.fn((fn) => fn()),
    runAuthTask: jest.fn((fn) => fn()),
    runAuthTaskWithRetry: jest.fn((fn) => fn()),
    handle429Error: jest.fn((fn) => fn()),
    createAutoScalingLimiter: jest.fn(() => ({ run: jest.fn((fn) => fn()) })),
    PRIORITY: { UI: 1, TASK: 2, NORMAL: 0, HIGH: 10, LOW: -10, BACKGROUND: -20 },
    botLimiter: { run: jest.fn((fn) => fn()) }
}));

// --- Import under test ---
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');
const { STRINGS } = await import('../../src/locales/zh-CN.js');

describe('Remote Folder Integration Tests', () => {
    const userId = '123456789';
    const target = { className: 'PeerUser', userId: BigInt(userId) };

    beforeEach(() => {
        jest.clearAllMocks();
        mockSettingsGet.mockResolvedValue('public');
        mockFindByUserId.mockResolvedValue({ id: 'drive1', type: 'mega', remote_folder: null });
    });

    describe('/remote_folder command', () => {
        it('should show the remote folder menu', async () => {
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/remote_folder',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('上传路径设置'),
                buttons: expect.any(Array)
            }));
        });

        it('should show error if no drive bound', async () => {
            mockFindByUserId.mockResolvedValue(null);
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/remote_folder',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('需要先绑定网盘')
            }));
        });
    });

    describe('/set_remote_folder command', () => {
        it('should start interactive flow if no path provided', async () => {
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/set_remote_folder',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockSessionStart).toHaveBeenCalledWith(userId, 'REMOTE_FOLDER_WAIT_PATH');
            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('请输入上传路径')
            }));
        });

        it('should set path directly if provided', async () => {
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/set_remote_folder /Movies/2024',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockUpdateRemoteFolder).toHaveBeenCalledWith('drive1', '/Movies/2024');
            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('上传路径已设置')
            }));
        });

        it('should reset path if "reset" provided', async () => {
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/set_remote_folder reset',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockUpdateRemoteFolder).toHaveBeenCalledWith('drive1', null);
            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('已重置为默认路径')
            }));
        });

        it('should show error for invalid path', async () => {
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/set_remote_folder invalid-path',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('路径格式无效')
            }));
        });
    });

    describe('Interactive Input Handling', () => {
        it('should handle valid path input during session', async () => {
            mockSessionGet.mockResolvedValue({ current_step: 'REMOTE_FOLDER_WAIT_PATH' });
            
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: '/Movies/2024',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockUpdateRemoteFolder).toHaveBeenCalledWith('drive1', '/Movies/2024');
            expect(mockSessionClear).toHaveBeenCalledWith(userId);
            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('上传路径已设置')
            }));
        });

        it('should show error for invalid path input during session', async () => {
            mockSessionGet.mockResolvedValue({ current_step: 'REMOTE_FOLDER_WAIT_PATH' });
            
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    message: 'invalid',
                    peerId: target,
                    fromId: { userId: BigInt(userId) }
                }
            };

            await Dispatcher.handle(event);

            expect(mockSendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: expect.stringContaining('路径格式无效')
            }));
            expect(mockUpdateRemoteFolder).not.toHaveBeenCalled();
        });
    });
});
