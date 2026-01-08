import { jest } from '@jest/globals';

// 使用 unstable_mockModule 以支持 ESM 环境下的 Mock
// 必须在 import 被测试模块之前执行

// Mock config
await jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: {
        ownerId: null  // 默认无 owner，确保测试可预测
    }
}));

// Mock telegram.js 避免副作用
await jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    client: {
        session: { save: () => '' },
        getMe: jest.fn(),
        invoke: jest.fn().mockResolvedValue({})
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

// Mock logger
await jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

// 动态导入被测试模块
const { MessageHandler } = await import('../../src/dispatcher/MessageHandler.js');
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');
const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
const { logger } = await import('../../src/services/logger.js');

describe('MessageHandler Integration Tests', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        // 重置静态属性
        MessageHandler.botId = null;

        mockClient = {
            session: { save: () => 'mock_session' },
            getMe: jest.fn().mockResolvedValue({ id: 123456 }),
            invoke: jest.fn().mockResolvedValue({}),
            connected: true
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

    describe('Safe Serialization', () => {
        it('should safely serialize unknown events with circular references', async () => {
            // 模拟包含深层循环引用的 GramJS 对象结构
            const circularObj = { className: 'PeerUser' };
            circularObj.client = { _eventBuilders: [] };
            circularObj.client._eventBuilders.push({ raw: circularObj }); // 形成循环

            const event = {
                className: 'UnknownEvent',
                message: {
                    id: 123,
                    message: 'test circular',
                    peerId: circularObj
                }
            };

            // 应该不抛出 TypeError: Converting circular structure to JSON
            // 并且 Dispatcher.handle 应该仍然被调用 (说明序列化异常没中断流程)
            await MessageHandler.handleEvent(event, mockClient);
            expect(Dispatcher.handle).toHaveBeenCalled();
        });

        it('should handle BigInt and missing fields in safeSerializeEvent', async () => {
            const event = {
                className: 'MinimalEvent',
                id: BigInt(9876543210)
            };

            await MessageHandler.handleEvent(event, mockClient);
            expect(Dispatcher.handle).toHaveBeenCalled();
        });
    });

    describe('UpdateConnectionState Handling', () => {
        it('should handle connected state (state=1) with debug log', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                constructor: { name: 'UpdateConnectionState' },
                className: 'unknown',
                state: 1
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).toHaveBeenCalledWith(event);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.stringContaining('[UpdateConnectionState:connected]')
            );
            expect(logger.info).not.toHaveBeenCalledWith(
                expect.stringContaining('[UpdateConnectionState')
            );
        });

        it('should handle broken state (state=0) with debug log', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                constructor: { name: 'UpdateConnectionState' },
                className: 'unknown',
                state: 0
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).toHaveBeenCalledWith(event);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.stringContaining('[UpdateConnectionState:broken]')
            );
        });

        it('should handle disconnected state (state=-1) with debug log', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                constructor: { name: 'UpdateConnectionState' },
                className: 'unknown',
                state: -1
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).toHaveBeenCalledWith(event);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.stringContaining('[UpdateConnectionState:disconnected]')
            );
        });

        it('should handle unknown state number with debug log', async () => {
            instanceCoordinator.acquireLock.mockResolvedValue(true);

            const event = {
                constructor: { name: 'UpdateConnectionState' },
                className: 'unknown',
                state: 999
            };

            await MessageHandler.handleEvent(event, mockClient);

            expect(Dispatcher.handle).toHaveBeenCalledWith(event);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.stringContaining('[UpdateConnectionState:stateNum_999]')
            );
        });
    });
});
