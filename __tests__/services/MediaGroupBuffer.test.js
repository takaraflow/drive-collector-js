/**
 * MediaGroupBuffer.test.js
 * 
 * 测试分布式 MediaGroupBuffer 服务
 */

import { describe, test, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { MediaGroupBuffer } from '../../src/services/MediaGroupBuffer.js';
import { logger } from '../../src/services/logger/index.js';
import { cache } from '../../src/services/CacheService.js';
import { DistributedLock } from '../../src/services/DistributedLock.js';
import { TaskManager } from '../../src/processor/TaskManager.js';

// Mock logger
vi.mock('../../src/services/logger/index.js', () => ({
  logger: {
    withModule: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}));

// Mock CacheService
vi.mock('../../src/services/CacheService.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn(),
    compareAndSet: vi.fn()
  }
}));

// Mock DistributedLock
vi.mock('../../src/services/DistributedLock.js', () => {
  return {
    DistributedLock: class {
      constructor() {
        this.acquire = vi.fn();
        this.release = vi.fn();
        this.getLockStatus = vi.fn();
        this.getStats = vi.fn().mockResolvedValue({ total: 0, held: 0, expired: 0, local: 0 });
      }
    }
  };
});

// Mock TaskManager
vi.mock('../../src/processor/TaskManager.js', () => ({
  TaskManager: {
    addBatchTasks: vi.fn().mockResolvedValue(true)
  }
}));

describe('MediaGroupBuffer - 分布式媒体组缓冲服务', () => {
  let buffer;
  let mockDistributedLock;
  // let mockCache; // Removed local mockCache

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();
    
    // 重新导入并创建实例
    buffer = new MediaGroupBuffer({
      instanceId: 'test-instance',
      bufferTimeout: 100,
      maxBatchSize: 3,
      cleanupInterval: 1000
    });
    
    // 获取 buffer 内部的 mock 实例
    mockDistributedLock = buffer.distributedLock;
  });

  afterEach(() => {
    if (buffer && typeof buffer.cleanup === 'function') {
      buffer.cleanup();
    }
    vi.clearAllTimers();
  });

  describe('基本配置', () => {
    test('should create instance with default config', () => {
      expect(buffer).toBeDefined();
      expect(buffer.options.bufferTimeout).toBe(100);
      expect(buffer.options.maxBatchSize).toBe(3);
      expect(buffer.options.instanceId).toBe('test-instance');
      expect(buffer.persistKey).toBe('test-instance:media_group_buffer');
    });

    test('should create instance with custom config', () => {
      const customBuffer = new MediaGroupBuffer({
        instanceId: 'custom-instance',
        bufferTimeout: 2000,
        maxBatchSize: 5,
        persistKeyPrefix: 'custom_buffer'
      });
      
      expect(customBuffer.options.instanceId).toBe('custom-instance');
      expect(customBuffer.options.bufferTimeout).toBe(2000);
      expect(customBuffer.options.maxBatchSize).toBe(5);
      expect(customBuffer.persistKey).toBe('custom-instance:custom_buffer');
    });
  });

  describe('消息添加和缓冲', () => {
    test('should add message and acquire lock successfully', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock acquisition
      mockDistributedLock.acquire.mockResolvedValue({
        success: true,
        version: 'v1'
      });

      // Mock buffer size check
      cache.listKeys.mockResolvedValue(['test-instance:buffer:group-123:msg:msg-1']);

      // Mock message duplicate check
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) {
          return null; // Not duplicate
        }
        if (key.includes(':meta')) {
          return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        }
        return null;
      });

      const result = await buffer.add(message, target, userId);

      expect(result.added).toBe(true);
      expect(result.reason).toBe('buffered');
      
      // 验证锁获取
      expect(mockDistributedLock.acquire).toHaveBeenCalledWith('group-123', 'test-instance');
      
      // 验证消息存储
      expect(cache.set).toHaveBeenCalled();
    });

    test('should handle duplicate messages', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock duplicate check
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) {
          return '1'; // Already processed
        }
        return null;
      });

      const result = await buffer.add(message, target, userId);

      expect(result.added).toBe(false);
      expect(result.reason).toBe('duplicate');
      expect(mockDistributedLock.acquire).not.toHaveBeenCalled();
    });

    test('should buffer message when lock is held by another instance', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock held by another instance
      mockDistributedLock.acquire.mockResolvedValue({
        success: false,
        reason: 'lock_held',
        currentOwner: 'other-instance'
      });

      // Mock message duplicate check
      cache.get.mockReturnValue(null);

      const result = await buffer.add(message, target, userId);

      expect(result.added).toBe(true);
      expect(result.reason).toBe('buffered_by_other_instance');
      
      // 验证消息仍然存储到 Redis
      expect(cache.set).toHaveBeenCalled();
    });

    test('should flush buffer when batch size is reached', async () => {
      const messages = [
        { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123' },
        { id: 'msg-2', media: { file_id: 'photo2' }, groupedId: 'group-123' },
        { id: 'msg-3', media: { file_id: 'photo3' }, groupedId: 'group-123' }
      ];
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock acquisition
      mockDistributedLock.acquire.mockResolvedValue({
        success: true,
        version: 'v1'
      });

      // Mock lock status check
      mockDistributedLock.getLockStatus.mockResolvedValue({
        status: 'held',
        owner: 'test-instance',
        version: 'v1'
      });

      // Mock buffer operations
      cache.listKeys.mockImplementation((pattern) => {
        // Return message keys for size check and getAllMessages
        if (!pattern || pattern.includes(':msg:')) {
           return ['test-instance:buffer:group-123:msg:msg-1', 'test-instance:buffer:group-123:msg:msg-2', 'test-instance:buffer:group-123:msg:msg-3'];
        }
        return [];
      });

      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        if (key.includes(':msg:msg-2')) return { id: 'msg-2', media: { file_id: 'photo2' }, groupedId: 'group-123', _seq: 2 };
        if (key.includes(':msg:msg-3')) return { id: 'msg-3', media: { file_id: 'photo3' }, groupedId: 'group-123', _seq: 3 };
        return null;
      });

      // Add messages
      for (const msg of messages) {
        await buffer.add(msg, target, userId);
      }

      // 验证 TaskManager.addBatchTasks 被调用
      expect(TaskManager.addBatchTasks).toHaveBeenCalledWith(
        target,
        expect.arrayContaining([
          expect.objectContaining({ id: 'msg-1' }),
          expect.objectContaining({ id: 'msg-2' }),
          expect.objectContaining({ id: 'msg-3' })
        ]),
        userId
      );

      // 验证锁被释放
      expect(mockDistributedLock.release).toHaveBeenCalledWith('group-123', 'test-instance');
    });
  });

  describe('超时处理', () => {
    test('should flush buffer on timeout', async () => {
      vi.useFakeTimers();
      
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock acquisition
      mockDistributedLock.acquire.mockResolvedValue({
        success: true,
        version: 'v1'
      });

      // Mock lock status check
      mockDistributedLock.getLockStatus.mockResolvedValue({
        status: 'held',
        owner: 'test-instance',
        version: 'v1'
      });

      // Mock buffer operations
      cache.listKeys.mockImplementation((pattern) => {
        if (pattern && pattern.includes(':timer:')) {
            return ['test-instance:timer:group-123'];
        }
        if (pattern && pattern.includes(':msg:')) {
            return ['test-instance:buffer:group-123:msg:msg-1'];
        }
        return [];
      });
      
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        if (key.includes(':timer:')) {
             return {
                 expiresAt: Date.now() - 1000, // Ensure it is expired
                 lockVersion: 'v1',
                 instanceId: 'test-instance'
             };
        }
        return null;
      });

      // Add message
      await buffer.add(message, target, userId);

      // Trigger cleanup manually to verify logic
      await buffer._cleanupStaleBuffers();

      // 验证 flush 被调用
      expect(TaskManager.addBatchTasks).toHaveBeenCalled();
      expect(mockDistributedLock.release).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('分布式锁保护', () => {
    test('should verify lock ownership before flushing', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock acquisition
      mockDistributedLock.acquire.mockResolvedValue({
        success: true,
        version: 'v1'
      });

      // Mock lock status - lock lost during processing
      mockDistributedLock.getLockStatus.mockResolvedValue({
        status: 'released',
        taskId: 'group-123'
      });

      // Mock buffer operations
      cache.listKeys.mockImplementation((pattern) => {
        // Handle listKeys for getAllMessages
        if (!pattern || pattern.includes(':msg:')) {
            return ['test-instance:buffer:group-123:msg:msg-1'];
        }
        return [];
      });
      
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        return null;
      });

      // Add message to trigger flush (pretend batch size reached or force flush)
      // Actually we need to simulate flush trigger.
      // If we use `add`, we need batch size reached.
      // Or we can call `_flushBufferWithLock` directly but it's private.
      // We can use `add` with maxBatchSize 1.
      
      // But the test uses default maxBatchSize 3.
      // So we need to mock size 3.
      
      cache.listKeys.mockImplementation((pattern) => {
         if (!pattern || pattern.includes(':msg:')) {
             return ['msg1', 'msg2', 'msg3']; // Simulate 3 msgs
         }
         return [];
      });
      
      // Add message
      await buffer.add(message, target, userId);

      // 验证 TaskManager 未被调用（因为锁丢失）
      expect(TaskManager.addBatchTasks).not.toHaveBeenCalled();
      
      // 验证锁被释放
      expect(mockDistributedLock.release).toHaveBeenCalled();
    });

    test('should handle lock acquisition failure gracefully', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock acquisition failure
      mockDistributedLock.acquire.mockResolvedValue({
        success: false,
        reason: 'lock_held',
        currentOwner: 'other-instance'
      });

      // Mock duplicate check
      cache.get.mockReturnValue(null);

      const result = await buffer.add(message, target, userId);

      expect(result.added).toBe(true);
      expect(result.reason).toBe('buffered_by_other_instance');
      expect(mockDistributedLock.release).not.toHaveBeenCalled();
    });
  });

  describe('持久化和恢复', () => {
    test('should persist buffers to Redis', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Add message first
      mockDistributedLock.acquire.mockResolvedValue({ success: true, version: 'v1' });
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        return null;
      });
      cache.listKeys.mockResolvedValue([]);

      await buffer.add(message, target, userId);

      // Call persist
      // Mock listKeys to return meta keys
      cache.listKeys.mockImplementation((pattern) => {
          if (pattern && pattern.includes(':meta')) {
              return ['test-instance:buffer:group-123:meta'];
          }
          if (pattern && pattern.includes(':msg:')) {
              return ['test-instance:buffer:group-123:msg:msg-1'];
          }
          return [];
      });
      
      cache.get.mockImplementation((key) => {
        if (key === 'test-instance:media_group_buffer') return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        return null;
      });

      await buffer.persist();

      // 验证 persist 被调用
      expect(cache.set).toHaveBeenCalledWith(
        'test-instance:media_group_buffer',
        expect.objectContaining({
          instanceId: 'test-instance',
          buffers: expect.any(Array)
        }),
        60
      );
    });

    test('should restore buffers from Redis', async () => {
      const mockPersistedData = {
        instanceId: 'test-instance',
        timestamp: Date.now(),
        buffers: [{
          gid: 'group-123',
          target: { id: 'target-1' },
          userId: 'user-1',
          messages: [{
            id: 'msg-1',
            media: { file_id: 'photo1' },
            groupedId: 'group-123',
            _seq: 1
          }],
          createdAt: Date.now()
        }]
      };

      cache.get.mockImplementation((key) => {
          if (key === 'test-instance:media_group_buffer') return mockPersistedData;
          return null;
      });
      
      mockDistributedLock.acquire.mockResolvedValue({ success: true, version: 'v1' });
      mockDistributedLock.getLockStatus.mockResolvedValue({
        status: 'held',
        owner: 'test-instance',
        version: 'v1'
      });
      
      cache.listKeys.mockImplementation((pattern) => {
          if (pattern && pattern.includes(':msg:')) {
              return ['test-instance:buffer:group-123:msg:msg-1'];
          }
          return [];
      });
      
      // Need to mock get for getAllMessages during flush
      cache.get.mockImplementation((key) => {
        if (key === 'test-instance:media_group_buffer') return mockPersistedData;
        if (key.includes(':meta')) return { target: { id: 'target-1' }, userId: 'user-1', createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        return null;
      });

      await buffer.restore();

      // 验证消息被重新添加
      expect(cache.set).toHaveBeenCalled();
      // 验证 flush 被调用
      expect(TaskManager.addBatchTasks).toHaveBeenCalled();
    });

    test('should not restore expired buffers', async () => {
      const oldTimestamp = Date.now() - 200000; // 超过 staleThreshold
      const mockPersistedData = {
        instanceId: 'test-instance',
        timestamp: oldTimestamp,
        buffers: [{
          gid: 'group-123',
          target: { id: 'target-1' },
          userId: 'user-1',
          messages: [{ id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 }],
          createdAt: oldTimestamp
        }]
      };

      cache.get.mockResolvedValue(mockPersistedData);

      await buffer.restore();

      // 验证没有添加消息
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('状态监控', () => {
    test('should return buffer status', async () => {
      // Mock buffer keys
      cache.listKeys.mockImplementation((pattern) => {
        if (pattern.includes(':buffer:*:meta')) {
          return ['test-instance:buffer:group-123:meta', 'test-instance:buffer:group-456:meta'];
        }
        if (pattern.includes(':msg:*')) {
          return ['test-instance:buffer:group-123:msg:msg-1', 'test-instance:buffer:group-123:msg:msg-2'];
        }
        return [];
      });

      const status = await buffer.getStatus();

      expect(status).toEqual({
        instanceId: 'test-instance',
        activeBuffers: 2,
        bufferedMessages: 4, // 2 buffers * 2 messages each = 4
        localBufferKeys: 0,
        distributedLocks: { total: 0, held: 0, expired: 0, local: 0 },
        localMessageIds: 0 // Added this expectation
      });
    });
  });

  describe('清理任务', () => {
    test('should cleanup stale buffers periodically', async () => {
      vi.useFakeTimers();

      const timerKey = 'test-instance:timer:group-123';
      const timerData = {
        expiresAt: Date.now() - 1000, // 已过期
        lockVersion: 'v1',
        instanceId: 'test-instance'
      };

      // Mock buffer data for cleanup and finding expired timer
      cache.listKeys.mockImplementation((pattern) => {
        if (pattern.includes(':timer:')) return [timerKey];
        if (pattern.includes(':msg:*')) return ['test-instance:buffer:group-123:msg:msg-1'];
        return [];
      });

      cache.get.mockImplementation((key) => {
        if (key === timerKey) return timerData;
        if (key.includes(':meta')) return { target: { id: 'target-1' }, userId: 'user-1', createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        return null;
      });

      // Mock lock acquisition for cleanup
      mockDistributedLock.acquire.mockResolvedValue({ success: true, version: 'v2' });
      mockDistributedLock.getLockStatus.mockResolvedValue({
        status: 'held',
        owner: 'test-instance',
        version: 'v2'
      });

      // Trigger cleanup manually
      await buffer._cleanupStaleBuffers();

      // 验证过期缓冲区被清理
      expect(cache.delete).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('错误处理', () => {
    test('should handle cache errors gracefully', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock cache error
      cache.get.mockRejectedValue(new Error('Cache error'));

      await expect(buffer.add(message, target, userId)).rejects.toThrow('Cache error');
    });

    test('should handle lock errors gracefully', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock error
      mockDistributedLock.acquire.mockRejectedValue(new Error('Lock error'));
      
      // Also cache.get must return something? No, acquire is called early.
      // But verify cache.get implementation is not breaking.
      
      // In add():
      // _isMessageDuplicate -> cache.get
      // then acquire.
      
      cache.get.mockImplementation((key) => {
          if (key.includes('processed_messages')) return null;
          return null;
      });

      await expect(buffer.add(message, target, userId)).rejects.toThrow('Lock error');
    });

    test('should retry failed flush operations', async () => {
      const message = {
        id: 'msg-1',
        media: { file_id: 'photo1' },
        groupedId: 'group-123'
      };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock lock acquisition
      mockDistributedLock.acquire.mockResolvedValue({ success: true, version: 'v1' });

      // First call fails, second succeeds
      let callCount = 0;
      TaskManager.addBatchTasks.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('Temporary error');
        return Promise.resolve();
      });

      // Mock lock status
      mockDistributedLock.getLockStatus.mockResolvedValue({
        status: 'held',
        owner: 'test-instance',
        version: 'v1'
      });

      // Mock buffer operations
      // Ensure listKeys works
      cache.listKeys.mockImplementation((pattern) => {
          if (!pattern || pattern.includes(':msg:')) return ['test-instance:buffer:group-123:msg:msg-1'];
          return [];
      });
      
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        // Return initial errorCount 0
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0 };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        return null;
      });

      // Set batch size to 1 to force flush
      buffer.options.maxBatchSize = 1;

      // Add message
      // ...
      
      await buffer.add(message, target, userId);

      // 验证错误计数被更新 (should be 1 now)
      expect(cache.set).toHaveBeenCalledWith(
        expect.stringContaining(':meta'),
        expect.objectContaining({ errorCount: 1 }),
        expect.any(Number)
      );
    });
  });

  describe('多实例并发测试', () => {
    test('should handle concurrent message additions from multiple instances', async () => {
      const message1 = { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123' };
      const message2 = { id: 'msg-2', media: { file_id: 'photo2' }, groupedId: 'group-123' };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Instance A gets lock
      const bufferA = new MediaGroupBuffer({ instanceId: 'instance-A', bufferTimeout: 100, maxBatchSize: 2 });
      // We need to ensure distributedLock is properly initialized with mocks
      // Since our mock factory returns a new object each time, bufferA.distributedLock is a new mock object
      const mockLockA = bufferA.distributedLock;
      mockLockA.acquire.mockResolvedValue({ success: true, version: 'v1' });
      mockLockA.getLockStatus.mockResolvedValue({ status: 'held', owner: 'instance-A', version: 'v1' });
      mockLockA.getStats.mockResolvedValue({ total: 1, held: 1, expired: 0, local: 1 });

      // Instance B tries to get lock but fails
      const bufferB = new MediaGroupBuffer({ instanceId: 'instance-B', bufferTimeout: 100, maxBatchSize: 2 });
      const mockLockB = bufferB.distributedLock;
      mockLockB.acquire.mockResolvedValue({ success: false, reason: 'lock_held', currentOwner: 'instance-A' });
      mockLockB.getStats.mockResolvedValue({ total: 1, held: 1, expired: 0, local: 0 });

      // Mock cache operations
      const mockCacheOps = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listKeys: vi.fn()
      };

      // Setup mock cache behavior
      mockCacheOps.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        return null;
      });

      mockCacheOps.listKeys.mockImplementation((pattern) => {
        if (pattern.includes(':msg:*')) {
          return ['instance-A:buffer:group-123:msg:msg-1', 'instance-B:buffer:group-123:msg:msg-2'];
        }
        return [];
      });

      // Override cache in buffers
      // Since we can't easily override the cache used in the constructor (it's imported),
      // we have to rely on the fact that they use the same `cache` module which is mocked.
      
      // However, to simulate concurrent instances A and B, we can just use the fact that they use different instanceIds
      // and we check if acquire is called with correct args.
      
      // Note: bufferA and bufferB both use the same imported `cache` object.
      // We need to mock cache such that it returns different things for different keys if needed.
      // But here we just mock set to track calls.

      // Add messages concurrently
      const results = await Promise.all([
        bufferA.add(message1, target, userId),
        bufferB.add(message2, target, userId)
      ]);

      // 验证结果
      expect(results[0].added).toBe(true);
      expect(results[1].added).toBe(true);

      // 验证 Instance A 获得了锁
      expect(mockLockA.acquire).toHaveBeenCalledWith('group-123', 'instance-A');
      
      // 验证 Instance B 缓冲了消息
      expect(mockLockB.acquire).toHaveBeenCalledWith('group-123', 'instance-B');

      // 清理
      bufferA.cleanup();
      bufferB.cleanup();
    });


    test('should handle race condition in lock acquisition', async () => {
      const message = { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123' };
      const target = { id: 'target-1' };
      const userId = 'user-1';

      // Mock race condition: lock acquired but then lost
      let lockVersion = 'v1';
      mockDistributedLock.acquire.mockResolvedValue({ success: true, version: lockVersion });
      
      // First status check: lock held
      // Second status check: lock lost (race condition)
      let statusCallCount = 0;
      mockDistributedLock.getLockStatus.mockImplementation(() => {
        statusCallCount++;
        if (statusCallCount === 1) {
          // This call is likely from inside flush? No, flush calls it once.
          // Wait, add -> flush -> getLockStatus.
          // We want it to fail inside flush.
          return { status: 'held', owner: 'test-instance', version: lockVersion };
        }
        return { status: 'released' };
      });
      
      // But we want to simulate "lock acquired but then lost before flush finishes".
      // Code:
      // acquire() -> success.
      // flush() -> getLockStatus().
      
      // If we want flush to abort, getLockStatus should return released.
      mockDistributedLock.getLockStatus.mockResolvedValue({
          status: 'released',
          taskId: 'group-123'
      });

      // Mock buffer operations
      cache.listKeys.mockImplementation((pattern) => {
          if (!pattern || pattern.includes(':msg:')) return ['msg1'];
          return [];
      });
      buffer.options.maxBatchSize = 1;
      
      cache.get.mockImplementation((key) => {
        if (key.includes('processed_messages')) return null;
        if (key.includes(':meta')) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
        if (key.includes(':msg:msg-1')) return { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 };
        return null;
      });

      await buffer.add(message, target, userId);

      // 验证 TaskManager 未被调用（因为锁丢失）
      expect(TaskManager.addBatchTasks).not.toHaveBeenCalled();
      
      // 验证锁被释放 (release is called in finally block)
      expect(mockDistributedLock.release).toHaveBeenCalled();
    });
  });
});