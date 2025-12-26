import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// 1. 定义 Mock 函数
const mockAddEventHandler = jest.fn();
const mockStart = jest.fn();
const mockDisconnect = jest.fn();

const mockInstanceCoordinator = {
    start: jest.fn(),
    stop: jest.fn(),
    getInstanceId: jest.fn(() => 'test-instance-123'),
    isLeader: jest.fn(() => true)
};

const mockDatabaseService = {
    startFlushing: jest.fn()
};

const mockTaskManager = {
    startPolling: jest.fn(),
    stopPolling: jest.fn()
};

// 2. 注册 Mock 模块 (必须在 import bot.js 之前)
jest.unstable_mockModule('../src/config/index.js', () => ({
    config: {
        remoteFolder: 'test-folder'
    }
}));

jest.unstable_mockModule('../src/services/telegram.js', () => ({
    client: {
        addEventHandler: mockAddEventHandler,
        start: mockStart,
        disconnect: mockDisconnect
    }
}));

jest.unstable_mockModule('../src/bot/Dispatcher.js', () => ({
    Dispatcher: {
        handle: {
            bind: jest.fn(() => 'mock-handler-bound')
        }
    }
}));

jest.unstable_mockModule('../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

jest.unstable_mockModule('../src/services/database.js', () => ({
    DatabaseService: mockDatabaseService
}));

jest.unstable_mockModule('../src/core/TaskManager.js', () => ({
    TaskManager: mockTaskManager
}));

jest.unstable_mockModule('../src/services/kv.js', () => ({
    kv: {
        set: jest.fn(),
        get: jest.fn(),
        delete: jest.fn()
    }
}));

describe('Bot Entry Point', () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        jest.clearAllMocks();

        // 设置默认行为
        mockStart.mockResolvedValue(undefined);
        mockDisconnect.mockResolvedValue(undefined);
        mockInstanceCoordinator.start.mockResolvedValue(undefined);
        mockInstanceCoordinator.stop.mockResolvedValue(undefined);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should start bot successfully with required environment variables', async () => {
        process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
        
        // 动态导入 bot.js
        const { startBot } = await import('../bot.js');

        await startBot();

        expect(mockInstanceCoordinator.start).toHaveBeenCalledTimes(1);
        expect(mockDatabaseService.startFlushing).toHaveBeenCalledTimes(1);
        expect(mockTaskManager.startPolling).toHaveBeenCalledTimes(1);
        expect(mockAddEventHandler).toHaveBeenCalledTimes(1);
        expect(mockStart).toHaveBeenCalledWith({
            botAuthToken: 'test-bot-token'
        });
    });

    it('should handle startup error', async () => {
        process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
        mockInstanceCoordinator.start.mockRejectedValue(new Error('Startup Failed'));

        // 模拟 process.exit
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
        const { startBot } = await import('../bot.js');

        await startBot();

        expect(exitSpy).toHaveBeenCalledWith(1);
        exitSpy.mockRestore();
    });
});