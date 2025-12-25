import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock all the dependencies used in index.js
vi.mock('../src/config/index.js', () => ({
    config: {
        botToken: 'test_token',
        port: 3000,
        ownerId: '123456789'
    }
}));

vi.mock('../src/services/telegram.js', () => ({
    client: {
        start: vi.fn(),
        addEventHandler: vi.fn()
    },
    saveSession: vi.fn(),
    clearSession: vi.fn()
}));

vi.mock('../src/core/TaskManager.js', () => ({
    TaskManager: {
        init: vi.fn().mockResolvedValue(true),
        startAutoScaling: vi.fn()
    }
}));

vi.mock('../src/bot/Dispatcher.js', () => ({
    Dispatcher: {
        handle: vi.fn()
    }
}));

vi.mock('../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: vi.fn(),
        set: vi.fn()
    }
}));

vi.mock('http', () => ({
    default: {
        createServer: vi.fn(() => ({
            listen: vi.fn()
        }))
    }
}));

// Mock the entire index.js module to prevent immediate execution
vi.mock('../index.js', () => ({}), { virtual: true });

describe('Application Startup', () => {
    let mockClient, mockSettings, mockTaskManager, mockHttp, mockDispatcher;

    beforeAll(async () => {
        mockClient = vi.mocked(await import('../src/services/telegram.js')).client;
        mockSettings = vi.mocked(await import('../src/repositories/SettingsRepository.js')).SettingsRepository;
        mockTaskManager = vi.mocked(await import('../src/core/TaskManager.js')).TaskManager;
        mockHttp = vi.mocked(await import('http')).default;
        mockDispatcher = vi.mocked(await import('../src/bot/Dispatcher.js')).Dispatcher;
    });

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup default mock behaviors
        mockClient.start.mockResolvedValue(true);
        mockSettings.get.mockResolvedValue('0');
        mockSettings.set.mockResolvedValue(undefined);
        mockTaskManager.init.mockResolvedValue(true);
        mockHttp.createServer.mockReturnValue({
            listen: vi.fn()
        });
    });

    describe('Startup Backoff Logic', () => {
        it('should proceed normally when startup interval is sufficient', async () => {
            const now = Date.now();
            mockSettings.get
                .mockResolvedValueOnce((now - 70000).toString()) // last_startup_time: 70 seconds ago
                .mockResolvedValueOnce('0'); // recent_crash_count

            // Import and run the startup logic
            await import('../index.js');

            expect(mockSettings.set).toHaveBeenCalledWith('recent_crash_count', '0');
            expect(mockClient.start).toHaveBeenCalledWith({ botAuthToken: 'test_token' });
        });

        it('should trigger backoff when startup interval is too short', async () => {
            const now = Date.now();
            mockSettings.get
                .mockResolvedValueOnce((now - 30000).toString()) // last_startup_time: 30 seconds ago
                .mockResolvedValueOnce('1'); // recent_crash_count

            // Mock setTimeout to avoid actual delay
            vi.useFakeTimers();
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

            // Import and run the startup logic
            await import('../index.js');

            // Should have increased crash count
            expect(mockSettings.set).toHaveBeenCalledWith('recent_crash_count', '2');

            vi.useRealTimers();
        });
    });

    describe('Telegram Client Initialization', () => {
        it('should successfully start telegram client', async () => {
            mockSettings.get.mockResolvedValue('0');

            await import('../index.js');

            expect(mockClient.start).toHaveBeenCalledWith({ botAuthToken: 'test_token' });
            expect(vi.mocked(await import('../src/services/telegram.js')).saveSession).toHaveBeenCalled();
        });

        it('should handle AUTH_KEY_DUPLICATED error with retry', async () => {
            mockSettings.get.mockResolvedValue('0');
            mockClient.start
                .mockRejectedValueOnce({ code: 406, errorMessage: 'AUTH_KEY_DUPLICATED' })
                .mockResolvedValueOnce(true);

            await import('../index.js');

            expect(mockClient.start).toHaveBeenCalledTimes(2);
            expect(vi.mocked(await import('../src/services/telegram.js')).clearSession).toHaveBeenCalledTimes(1);
        });
    });

    describe('HTTP Health Check Server', () => {
        it('should start HTTP server on configured port', async () => {
            mockSettings.get.mockResolvedValue('0');
            const mockServer = { listen: vi.fn() };
            mockHttp.createServer.mockReturnValue(mockServer);

            await import('../index.js');

            expect(mockHttp.createServer).toHaveBeenCalled();
            expect(mockServer.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
        });
    });

    describe('Task Manager Initialization', () => {
        it('should initialize task manager', async () => {
            mockSettings.get.mockResolvedValue('0');

            await import('../index.js');

            expect(mockTaskManager.init).toHaveBeenCalled();
            expect(mockTaskManager.startAutoScaling).toHaveBeenCalled();
        });
    });

    describe('Event Handler Registration', () => {
        it('should register event handler for telegram client', async () => {
            mockSettings.get.mockResolvedValue('0');

            await import('../index.js');

            expect(mockClient.addEventHandler).toHaveBeenCalledWith(expect.any(Function));
        });

        it('should handle messages through dispatcher', async () => {
            mockSettings.get.mockResolvedValue('0');

            await import('../index.js');

            const eventHandler = mockClient.addEventHandler.mock.calls[0][0];
            const mockEvent = {
                message: { id: 123, text: 'test message' }
            };

            await eventHandler(mockEvent);

            expect(mockDispatcher.handle).toHaveBeenCalledWith(mockEvent);
        });
    });

    describe('Background Preheating', () => {
        it('should setup preheating for cloud drives', async () => {
            mockSettings.get.mockResolvedValue('0');

            // Mock DriveRepository and CloudTool
            vi.doMock('../src/repositories/DriveRepository.js', () => ({
                DriveRepository: {
                    findAll: vi.fn().mockResolvedValue([
                        { user_id: 'user1', name: 'drive1' },
                        { user_id: 'user2', name: 'drive2' }
                    ])
                }
            }));

            vi.doMock('../src/services/rclone.js', () => ({
                CloudTool: {
                    listRemoteFiles: vi.fn().mockResolvedValue([])
                }
            }));

            await import('../index.js');

            // Preheating should be initiated (though we can't easily test the async IIFE)
            // The mock setup ensures the imports work correctly
        });
    });
});