// 使用 unstable_mockModule 以支持 ESM 环境下的 Mock
// 必须在 import 被测试模块之前执行

// Mock config
await vi.doMock('../../src/config/index.js', () => ({
    config: {
        ownerId: null  // 默认无 owner，确保测试可预测
    }
}));

// Mock telegram.js 避免副作用
await vi.doMock('../../src/services/telegram.js', () => ({
    client: {
        session: { save: () => '' },
        getMe: vi.fn(),
        invoke: vi.fn().mockResolvedValue({})
    },
    saveSession: vi.fn(),
    clearSession: vi.fn(),
    resetClientSession: vi.fn()
}));

// Mock Dispatcher
await vi.doMock('../../src/dispatcher/Dispatcher.js', () => ({
    Dispatcher: {
        handle: vi.fn().mockResolvedValue(true)
    }
}));

// Mock InstanceCoordinator
await vi.doMock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        acquireLock: vi.fn()
    }
}));

// Mock logger
await vi.doMock('../../src/services/logger/index.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            withModule: vi.fn().mockReturnThis(),
            withContext: vi.fn().mockReturnThis()
        }
    };
});

// 动态导入被测试模块
const { MessageHandler } = await import('../../src/dispatcher/MessageHandler.js');
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');
const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
const { logger } = await import('../../src/services/logger/index.js');

describe('MessageHandler Integration Tests', () => {
    let mockClient;

    beforeEach(() => {
        vi.clearAllMocks();
        // 重置静态属性
        MessageHandler.botId = null;

        mockClient = {
            session: { save: () => 'mock_session' },
            getMe: vi.fn().mockResolvedValue({ id: 123456 }),
            invoke: vi.fn().mockResolvedValue({}),
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

describe('LRUCache (Message Deduplication)', () => {
    let LRUCache;

    beforeAll(() => {
        LRUCache = class {
            constructor(maxSize = 10000, ttlMs = 10 * 60 * 1000) {
                this.maxSize = maxSize;
                this.ttlMs = ttlMs;
                this.cache = new Map();
            }

            set(key, value) {
                const now = Date.now();
                if (this.cache.has(key)) {
                    this.cache.delete(key);
                }
                if (this.cache.size >= this.maxSize) {
                    const oldestKey = this.cache.keys().next().value;
                    this.cache.delete(oldestKey);
                }
                this.cache.set(key, { value, timestamp: now });
            }

            get(key) {
                const entry = this.cache.get(key);
                if (!entry) return null;
                const now = Date.now();
                if (now - entry.timestamp > this.ttlMs) {
                    this.cache.delete(key);
                    return null;
                }
                this.cache.delete(key);
                this.cache.set(key, entry);
                return entry.value;
            }

            has(key) {
                return this.get(key) !== null;
            }

            cleanup() {
                const now = Date.now();
                for (const [key, entry] of this.cache.entries()) {
                    if (now - entry.timestamp > this.ttlMs) {
                        this.cache.delete(key);
                    }
                }
            }

            get size() {
                return this.cache.size;
            }
        };
    });

    it('should store and retrieve values', () => {
        const cache = new LRUCache(3, 60000);
        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for non-existent keys', () => {
        const cache = new LRUCache(3, 60000);
        expect(cache.get('nonexistent')).toBe(null);
    });

    it('should evict oldest entry when capacity is reached', () => {
        const cache = new LRUCache(3, 60000);
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        cache.set('key3', 'value3');
        cache.set('key4', 'value4'); // Should evict key1

        expect(cache.get('key1')).toBe(null);
        expect(cache.get('key2')).toBe('value2');
        expect(cache.get('key3')).toBe('value3');
        expect(cache.get('key4')).toBe('value4');
    });

    it('should update position on access (LRU behavior)', () => {
        const cache = new LRUCache(3, 60000);
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        cache.set('key3', 'value3');
        
        cache.get('key1'); // Access key1 to make it recent
        
        cache.set('key4', 'value4'); // Should evict key2 (not key1)

        expect(cache.get('key1')).toBe('value1');
        expect(cache.get('key2')).toBe(null);
        expect(cache.get('key3')).toBe('value3');
        expect(cache.get('key4')).toBe('value4');
    });

    it('should expire entries after TTL', async () => {
        const cache = new LRUCache(10, 100); // 100ms TTL
        cache.set('key1', 'value1');
        
        expect(cache.get('key1')).toBe('value1');
        
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(cache.get('key1')).toBe(null);
    });

    it('should support has() method', () => {
        const cache = new LRUCache(10, 60000);
        cache.set('key1', 'value1');
        
        expect(cache.has('key1')).toBe(true);
        expect(cache.has('nonexistent')).toBe(false);
    });

    it('should support cleanup() method', () => {
        const cache = new LRUCache(10, 100);
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        
        expect(cache.size).toBe(2);
        
        // Manually set old timestamps
        cache.cache.get('key1').timestamp = Date.now() - 200;
        
        cache.cleanup();
        
        expect(cache.size).toBe(1);
        expect(cache.has('key1')).toBe(false);
        expect(cache.has('key2')).toBe(true);
    });

    it('should return correct size', () => {
        const cache = new LRUCache(10, 60000);
        expect(cache.size).toBe(0);
        
        cache.set('key1', 'value1');
        expect(cache.size).toBe(1);
        
        cache.set('key2', 'value2');
        expect(cache.size).toBe(2);
        
        cache.cleanup(); // Trigger cleanup to remove expired entries
        expect(cache.size).toBe(2);
    });
});
