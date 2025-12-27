import { jest } from '@jest/globals';

// 使用 unstable_mockModule 以支持 ESM 环境下的 Mock
// 必须在 import 被测试模块之前执行

// Mock telegram.js 避免副作用
await jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    client: {
        session: { save: () => '' },
        getMe: jest.fn()
    },
    saveSession: jest.fn(),
    clearSession: jest.fn(),
    resetClientSession: jest.fn()
}));

// Mock Dispatcher
await jest.unstable_mockModule('../../src/dispatcher/Dispatcher.js', () => ({
    Dispatcher: {
        handle: jest.fn().mockResolvedValue(true)
    }
}));

// Mock InstanceCoordinator
await jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        acquireLock: jest.fn()
    }
}));

// 动态导入被测试模块
const { MessageHandler } = await import('../../src/dispatcher/MessageHandler.js');
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');
const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');

describe('MessageHandler Integration Tests', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        // 重置静态属性
        MessageHandler.botId = null;
        
        mockClient = {
            session: { save: () => 'mock_session' },
            getMe: jest.fn().mockResolvedValue({ id: 123456 })
        };
    });

    describe('Bot Self-Message Filtering', () => {
        it('should ignore messages with out=true (sent by self)', async () => {
            const event = {
                className: 'UpdateNewMessage',
                message: {
                    id: 1,
                    out: true,
                    message: 'Hello'
                }
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).not.toHaveBeenCalled();
        });

        it('should ignore messages where senderId matches botId', async () => {
            // 先初始化 Bot ID
            await MessageHandler.init(mockClient);
            expect(MessageHandler.botId).toBe('123456');

            const event = {
                className: 'UpdateNewMessage',
                message: {
                    id: 2,
                    out: false,
                    senderId: 123456, // 匹配 Bot ID
                    message: 'Welcome'
                }
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).not.toHaveBeenCalled();
        });

        it('should process normal user messages', async () => {
            // 确保 kv 锁获取成功
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                className: 'UpdateNewMessage',
                message: {
                    id: 3,
                    out: false,
                    senderId: 987654, // 其他用户
                    message: '/diagnosis'
                }
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).toHaveBeenCalledWith(event);
        });
    });

    describe('Distributed Deduplication', () => {
        it('should process message if lock is acquired', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                className: 'UpdateNewMessage',
                message: {
                    id: 100,
                    out: false,
                    senderId: 999
                }
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith('msg_lock:100', 60);
            expect(Dispatcher.handle).toHaveBeenCalled();
        });

        it('should NOT process message if lock is NOT acquired (handled by another instance)', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(false); // 模拟被其他实例抢占

            const event = {
                className: 'UpdateNewMessage',
                message: {
                    id: 101, // 相同 ID
                    out: false,
                    senderId: 999
                }
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith('msg_lock:101', 60);
            expect(Dispatcher.handle).not.toHaveBeenCalled(); // 应该被拦截
        });

        it('should use memory cache to avoid repeated KV calls', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                className: 'UpdateNewMessage',
                message: {
                    id: 200,
                    out: false,
                    senderId: 888
                }
            };

            // 第一次调用：应该请求 KV
            await MessageHandler.handleEvent(event, mockClient);
            expect(instanceCoordinator.acquireLock).toHaveBeenCalledTimes(1);

            // 第二次调用（相同 ID）：应该直接从内存返回，不请求 KV
            await MessageHandler.handleEvent(event, mockClient);
            expect(instanceCoordinator.acquireLock).toHaveBeenCalledTimes(1); // 仍然是 1
        });
    });
});