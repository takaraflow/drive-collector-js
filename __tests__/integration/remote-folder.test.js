// --- Mocks ---
vi.mock('../../src/config/index.js', () => ({
    config: {
        apiId: 12345,
        apiHash: 'test-api-hash',
        botToken: 'test-bot-token',
        ownerId: '123456789',
        downloadDir: '/tmp/downloads',
        remoteName: 'test-remote',
        remoteFolder: 'test-folder',
        port: '3000',
        http2: { enabled: false, plain: false, allowHttp1: true, keyPath: null, certPath: null },
        redis: { url: null, token: null, tls: { enabled: false } },
        kv: { accountId: null, namespaceId: null, token: null },
        qstash: { token: null, currentSigningKey: null, nextSigningKey: null, webhookUrl: null },
        oss: { endpoint: null, accessKeyId: null, secretAccessKey: null, bucket: 'drive-collector', publicUrl: null, workerUrl: null, workerSecret: null },
        d1: { accountId: null, databaseId: null, token: null },
        telegram: {
            apiId: 12345,
            apiHash: 'test-api-hash',
            deviceModel: 'DriveCollector',
            systemVersion: '1.0.0',
            appVersion: '4.7.1',
            serverDc: null,
            serverIp: null,
            serverPort: null,
            testMode: false,
            proxy: null
        }
    },
    getConfig: vi.fn().mockReturnValue({
        apiId: 12345,
        apiHash: 'test-api-hash',
        botToken: 'test-bot-token',
        ownerId: '123456789',
        downloadDir: '/tmp/downloads',
        remoteName: 'test-remote',
        remoteFolder: 'test-folder',
        port: '3000',
        http2: { enabled: false, plain: false, allowHttp1: true, keyPath: null, certPath: null },
        redis: { url: null, token: null, tls: { enabled: false } },
        kv: { accountId: null, namespaceId: null, token: null },
        qstash: { token: null, currentSigningKey: null, nextSigningKey: null, webhookUrl: null },
        oss: { endpoint: null, accessKeyId: null, secretAccessKey: null, bucket: 'drive-collector', publicUrl: null, workerUrl: null, workerSecret: null },
        d1: { accountId: null, databaseId: null, token: null },
        telegram: {
            apiId: 12345,
            apiHash: 'test-api-hash',
            deviceModel: 'DriveCollector',
            systemVersion: '1.0.0',
            appVersion: '4.7.1',
            serverDc: null,
            serverIp: null,
            serverPort: null,
            testMode: false,
            proxy: null
        }
    }),
    initConfig: vi.fn(),
    validateConfig: vi.fn().mockReturnValue(true),
    getRedisConnectionConfig: vi.fn().mockReturnValue({ url: '', options: {} }),
    __resetConfigForTests: vi.fn()
}));

vi.mock('../../src/services/telegram.js', () => ({
    client: {
        sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
        invoke: vi.fn().mockResolvedValue({})
    },
    isClientActive: () => true,
    getUpdateHealth: () => ({ lastUpdate: Date.now(), timeSince: 0 })
}));

// Create mock functions for DriveRepository
const mockFindByUserId = vi.fn();
const mockFindById = vi.fn().mockResolvedValue({ id: 'drive1', type: 'mega', remote_folder: null });
const mockUpdateRemoteFolder = vi.fn();

vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        findByUserId: mockFindByUserId,
        findById: mockFindById,
        updateRemoteFolder: mockUpdateRemoteFolder
    }
}));

// Create mock functions for SessionManager
const mockSessionStart = vi.fn();
const mockSessionGet = vi.fn();
const mockSessionClear = vi.fn();

vi.mock('../../src/modules/SessionManager.js', () => ({
    SessionManager: {
        start: mockSessionStart,
        get: mockSessionGet,
        clear: mockSessionClear
    }
}));

// Create mock functions for SettingsRepository
const mockSettingsGet = vi.fn();
const mockSettingsSet = vi.fn();

vi.mock('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: mockSettingsGet,
        set: mockSettingsSet
    }
}));

vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: {
        getRole: vi.fn().mockResolvedValue('user'),
        can: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTask: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    runAuthTask: vi.fn((fn) => fn()),
    runAuthTaskWithRetry: vi.fn((fn) => fn()),
    handle429Error: vi.fn((fn) => fn()),
    createAutoScalingLimiter: vi.fn(() => ({ run: vi.fn((fn) => fn()) })),
    PRIORITY: { UI: 1, TASK: 2, NORMAL: 0, HIGH: 10, LOW: -10, BACKGROUND: -20 },
    botLimiter: { run: vi.fn((fn) => fn()) }
}));

// Create mock function for telegram client sendMessage
const mockSendMessage = vi.fn().mockResolvedValue({ id: 123 });

vi.doMock('../../src/services/telegram.js', () => ({
    client: {
        sendMessage: mockSendMessage,
        invoke: vi.fn().mockResolvedValue({})
    },
    isClientActive: () => true,
    getUpdateHealth: () => ({ lastUpdate: Date.now(), timeSince: 0 })
}));

// --- Import under test ---
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');
import { STRINGS } from '../../src/locales/zh-CN.js';

describe('Remote Folder Integration Tests', () => {
    const userId = '123456789';
    const target = { className: 'PeerUser', userId: BigInt(userId) };

    beforeEach(async () => {
        vi.clearAllMocks();
        const { SettingsRepository } = await import('../../src/repositories/SettingsRepository.js');
        const { DriveRepository } = await import('../../src/repositories/DriveRepository.js');
        
        SettingsRepository.get.mockResolvedValue('public');
        DriveRepository.findByUserId.mockResolvedValue({ id: 'drive1', type: 'mega', remote_folder: null });
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

            expect(mockUpdateRemoteFolder).toHaveBeenCalledWith('drive1', '/Movies/2024', userId);
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

            expect(mockUpdateRemoteFolder).toHaveBeenCalledWith('drive1', null, userId);
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

            expect(mockUpdateRemoteFolder).toHaveBeenCalledWith('drive1', '/Movies/2024', userId);
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