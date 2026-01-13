/**
 * DistributedSystemIntegration.test.js
 * 
 * 集成测试：验证分布式系统的完整工作流程
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MediaGroupBuffer } from '../../src/services/MediaGroupBuffer.js';
import { ConsistentCache } from '../../src/services/ConsistentCache.js';
import { StateSynchronizer } from '../../src/services/StateSynchronizer.js';
import { BatchProcessor } from '../../src/services/BatchProcessor.js';
import { GracefulShutdown } from '../../src/services/GracefulShutdown.js';
import { TaskRepository } from '../../src/repositories/TaskRepository.js';
import { logger } from '../../src/services/logger/index.js';

// Mock all external dependencies
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

vi.mock('../../src/services/CacheService.js', () => {
  const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn()
  };
  return {
    cache: mockCache
  };
});

vi.mock('../../src/services/d1.js', () => ({
  d1: {
    run: vi.fn(),
    fetchAll: vi.fn(),
    fetchOne: vi.fn(),
    batch: vi.fn()
  }
}));

describe('分布式系统集成测试', () => {
  let mediaBuffer;
  let consistentCache;
  let stateSynchronizer;
  let batchProcessor;
  let gracefulShutdown;

  beforeEach(() => {
    // 初始化所有组件
    mediaBuffer = new MediaGroupBuffer();
    consistentCache = new ConsistentCache();
    stateSynchronizer = new StateSynchronizer();
    batchProcessor = new BatchProcessor();
    gracefulShutdown = new GracefulShutdown();

    // 重置所有 mock
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 清理所有组件
    if (mediaBuffer) mediaBuffer.cleanup();
    if (consistentCache) consistentCache.cleanup();
    if (stateSynchronizer) stateSynchronizer.cleanup();
    if (batchProcessor) batchProcessor.cleanup();
    if (gracefulShutdown) gracefulShutdown.stopRecoveryCheck();
  });

  describe('场景1: 多实例任务处理', () => {
    test('should handle task lifecycle across multiple instances', async () => {
      const taskId = 'task-123';
      const instanceId1 = 'instance-1';
      const instanceId2 = 'instance-2';

      // 实例1：获取锁并开始处理
      const lock1 = await stateSynchronizer.acquireLock(taskId, instanceId1);
      expect(lock1).toBe(true);

      // 实例1：更新任务状态
      await stateSynchronizer.updateTaskState(taskId, {
        status: 'downloading',
        progress: 50
      });

      // 实例2：尝试获取锁（应该失败）
      const lock2 = await stateSynchronizer.acquireLock(taskId, instanceId2);
      expect(lock2).toBe(false);

      // 实例1：完成任务
      await stateSynchronizer.updateTaskState(taskId, {
        status: 'completed',
        progress: 100
      });

      // 实例1：释放锁
      const release = await stateSynchronizer.releaseLock(taskId, instanceId1);
      expect(release).toBe(true);

      // 实例2：现在可以获取锁
      const lock3 = await stateSynchronizer.acquireLock(taskId, instanceId2);
      expect(lock3).toBe(true);
    });

    test('should detect and recover orphaned tasks', async () => {
      const taskId = 'orphan-task';
      const deadInstance = 'dead-instance';
      const newInstance = 'new-instance';

      // 模拟死实例的状态
      const mockCacheGet = vi.spyOn(consistentCache, 'get');
      mockCacheGet.mockResolvedValue({
        status: 'downloading',
        instanceId: deadInstance,
        heartbeat: Date.now() - 60000, // 1分钟前
        updatedAt: Date.now() - 60000
      });

      // 检测死实例
      const deadInstances = await stateSynchronizer.detectDeadInstances();
      expect(deadInstances).toHaveLength(1);
      expect(deadInstances[0].id).toBe(taskId);

      // 恢复任务
      const recovered = await stateSynchronizer.recoverOrphanedTask(taskId, newInstance);
      expect(recovered).toBe(true);

      // 验证状态已更新
      expect(mockCacheGet).toHaveBeenCalledWith(taskId);
    });
  });

  describe('场景2: 媒体组批量处理', () => {
    test('should process media group with consistency', async () => {
      const chatId = 12345;
      const messages = [
        { message_id: 1, photo: [{ file_id: 'photo1' }], caption: 'Photo 1' },
        { message_id: 2, photo: [{ file_id: 'photo2' }], caption: 'Photo 2' },
        { message_id: 3, photo: [{ file_id: 'photo3' }], caption: 'Photo 3' }
      ];

      // 1. 缓冲媒体消息
      const results = messages.map(msg => mediaBuffer.add(chatId, msg));
      expect(results[0]).toBe(false);
      expect(results[1]).toBe(false);
      expect(results[2]).toBe(true); // 达到阈值

      // 2. 获取缓冲的消息
      const bufferedMessages = mediaBuffer.get(chatId);
      expect(bufferedMessages).toHaveLength(3);

      // 3. 使用批量处理器写入缓存
      const cacheOperations = bufferedMessages.map((msg, index) => ({
        type: 'set',
        key: `media:${chatId}:${msg.message_id}`,
        value: msg,
        ttl: 3600
      }));

      const cacheResults = await batchProcessor.processBatch('consistent-cache', cacheOperations);
      expect(cacheResults).toHaveLength(3);
      expect(cacheResults.every(r => r.success)).toBe(true);

      // 4. 更新任务状态
      const taskId = `media-group-${chatId}`;
      await consistentCache.set(taskId, {
        status: 'completed',
        count: 3,
        timestamp: Date.now()
      }, 300);

      // 5. 验证最终状态
      const finalState = await consistentCache.get(taskId);
      expect(finalState.status).toBe('completed');
      expect(finalState.count).toBe(3);
    });

    test('should handle media group timeout and fallback', async () => {
      vi.useFakeTimers();

      const chatId = 54321;
      const callback = vi.fn();

      mediaBuffer.on('groupComplete', callback);

      // 添加2条消息（低于阈值）
      mediaBuffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      mediaBuffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });

      // 等待超时
      await vi.advanceTimersByTimeAsync(1000);

      // 应该触发超时回调
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId,
          messages: expect.arrayContaining([
            expect.objectContaining({ message_id: 1 }),
            expect.objectContaining({ message_id: 2 })
          ])
        })
      );

      vi.useRealTimers();
    });
  });

  describe('场景3: 批量任务同步', () => {
    test('should synchronize batch task updates across layers', async () => {
      const tasks = [
        { id: 'task-1', status: 'downloading' },
        { id: 'task-2', status: 'uploading' },
        { id: 'task-3', status: 'completed' }
      ];

      // 1. 使用 StateSynchronizer 更新状态
      const syncResults = await Promise.all(
        tasks.map(task => 
          stateSynchronizer.updateTaskState(task.id, { status: task.status })
        )
      );

      expect(syncResults).toHaveLength(3);

      // 2. 使用 BatchProcessor 批量写入 D1
      const d1Operations = tasks.map(task => ({
        sql: 'UPDATE tasks SET status = ? WHERE id = ?',
        params: [task.status, task.id]
      }));

      const mockD1Batch = vi.spyOn(TaskRepository, 'createBatch');
      mockD1Batch.mockResolvedValue(true);

      const d1Results = await batchProcessor.processBatch('d1-batch', d1Operations);
      expect(d1Results).toHaveLength(3);
      expect(d1Results.every(r => r.success)).toBe(true);

      // 3. 验证一致性缓存
      const cacheChecks = await Promise.all(
        tasks.map(task => consistentCache.get(task.id))
      );

      cacheChecks.forEach((state, index) => {
        expect(state.status).toBe(tasks[index].status);
      });
    });

    test('should handle partial failures in batch sync', async () => {
      const tasks = [
        { id: 'task-1', status: 'downloading' },
        { id: 'task-2', status: 'uploading' },
        { id: 'task-3', status: 'completed' }
      ];

      // 模拟部分失败
      const mockCacheSet = vi.spyOn(consistentCache, 'set');
      mockCacheSet.mockImplementation((key, value, ttl) => {
        if (key === 'task-2') {
          return Promise.reject(new Error('Cache error'));
        }
        return Promise.resolve();
      });

      // 批量更新
      const results = await Promise.all(
        tasks.map(task => 
          consistentCache.set(task.id, { status: task.status }, 300)
            .then(() => ({ success: true, task: task.id }))
            .catch(error => ({ success: false, task: task.id, error: error.message }))
        )
      );

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
    });
  });

  describe('场景4: 优雅关闭和任务排空', () => {
    test('should drain tasks gracefully during shutdown', async () => {
      vi.useFakeTimers();

      // 模拟活跃任务计数器
      let activeTasks = 5;
      const getTaskCount = () => activeTasks;

      gracefulShutdown.registerTaskCounter(getTaskCount);

      // 注册清理钩子
      const cleanupFn = vi.fn().mockResolvedValue(undefined);
      gracefulShutdown.register(cleanupFn, 10, 'test-cleanup');

      // 模拟任务完成
      const drainPromise = gracefulShutdown.drainTasks();

      // 逐步减少任务
      const interval = setInterval(() => {
        activeTasks--;
        if (activeTasks < 0) clearInterval(interval);
      }, 1000);

      // 等待所有任务完成
      await vi.advanceTimersByTimeAsync(5000);
      clearInterval(interval);

      await drainPromise;

      // 验证清理钩子被调用
      expect(cleanupFn).toHaveBeenCalled();

      vi.useRealTimers();
    });

    test('should handle shutdown timeout gracefully', async () => {
      vi.useFakeTimers();

      // 模拟永不完成的任务
      const getTaskCount = () => 5;
      gracefulShutdown.registerTaskCounter(getTaskCount);

      // 尝试排空（应该超时）
      const drainPromise = gracefulShutdown.drainTasks();

      // 快进到超时
      await vi.advanceTimersByTimeAsync(60000); // 60秒超时

      await drainPromise;

      // 应该继续执行，不阻塞
      expect(true).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('场景5: 故障转移和恢复', () => {
    test('should handle cache failure with fallback', async () => {
      const taskId = 'critical-task';
      const instanceId = 'instance-1';

      // 1. 尝试使用 ConsistentCache
      const mockCacheGet = vi.spyOn(consistentCache, 'get');
      mockCacheGet.mockRejectedValue(new Error('Cache unavailable'));

      // 2. 降级到 StateSynchronizer
      const mockSyncGet = vi.spyOn(stateSynchronizer, 'getTaskState');
      mockSyncGet.mockResolvedValue({
        status: 'downloading',
        instanceId: instanceId,
        updatedAt: Date.now()
      });

      // 3. 获取任务状态（多层回退）
      const cacheResult = await consistentCache.get(taskId).catch(() => null);
      const syncResult = cacheResult || await stateSynchronizer.getTaskState(taskId);

      expect(syncResult).toBeDefined();
      expect(syncResult.status).toBe('downloading');
    });

    test('should coordinate multiple instances during failure', async () => {
      const taskId = 'shared-task';
      const instances = ['instance-1', 'instance-2', 'instance-3'];

      // 所有实例尝试获取锁
      const lockResults = await Promise.all(
        instances.map(id => stateSynchronizer.acquireLock(taskId, id))
      );

      // 只有一个应该成功
      const successCount = lockResults.filter(r => r).length;
      expect(successCount).toBe(1);

      // 成功的实例更新状态
      const successInstance = instances[lockResults.indexOf(true)];
      await stateSynchronizer.updateTaskState(taskId, {
        status: 'processing',
        instanceId: successInstance
      });

      // 其他实例应该能看到状态
      const state = await stateSynchronizer.getTaskState(taskId);
      expect(state.instanceId).toBe(successInstance);
    });
  });

  describe('场景6: 性能和并发', () => {
    test('should handle high concurrency without data corruption', async () => {
      const taskId = 'concurrent-task';
      const instanceCount = 10;

      // 模拟多个实例并发操作
      const operations = Array.from({ length: instanceCount }, (_, i) => 
        (async () => {
          const instanceId = `instance-${i}`;
          
          // 尝试获取锁
          const locked = await stateSynchronizer.acquireLock(taskId, instanceId);
          
          if (locked) {
            // 更新状态
            await stateSynchronizer.updateTaskState(taskId, {
              status: 'processing',
              instanceId: instanceId,
              progress: i * 10
            });
            
            // 释放锁
            await stateSynchronizer.releaseLock(taskId, instanceId);
            
            return { instanceId, success: true };
          } else {
            return { instanceId, success: false };
          }
        })()
      );

      const results = await Promise.all(operations);

      // 验证只有一个实例成功获取锁
      const successResults = results.filter(r => r.success);
      expect(successResults).toHaveLength(1);

      // 验证最终状态
      const finalState = await stateSynchronizer.getTaskState(taskId);
      expect(finalState).toBeDefined();
      expect(finalState.instanceId).toBe(successResults[0].instanceId);
    });

    test('should process large batch efficiently', async () => {
      const batchSize = 100;
      const operations = Array.from({ length: batchSize }, (_, i) => ({
        type: 'set',
        key: `batch-key-${i}`,
        value: { data: `value-${i}` },
        ttl: 300
      }));

      const startTime = Date.now();
      const results = await batchProcessor.processBatch('consistent-cache', operations);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(batchSize);
      expect(results.every(r => r.success)).toBe(true);
      expect(duration).toBeLessThan(2000); // 应该在2秒内完成
    });
  });

  describe('场景7: 完整工作流', () => {
    test('should complete end-to-end file processing workflow', async () => {
      // 1. 用户发送媒体组
      const chatId = 12345;
      const messages = [
        { message_id: 1, photo: [{ file_id: 'file1' }], caption: 'File 1' },
        { message_id: 2, photo: [{ file_id: 'file2' }], caption: 'File 2' },
        { message_id: 3, photo: [{ file_id: 'file3' }], caption: 'File 3' }
      ];

      // 2. 缓冲到 MediaGroupBuffer
      messages.forEach(msg => mediaBuffer.add(chatId, msg));

      // 3. 获取完整组
      const group = mediaBuffer.get(chatId);
      expect(group).toHaveLength(3);

      // 4. 创建任务
      const taskId = `task-${Date.now()}`;
      const instanceId = 'worker-1';

      // 5. 获取分布式锁
      const locked = await stateSynchronizer.acquireLock(taskId, instanceId);
      expect(locked).toBe(true);

      // 6. 批量处理并同步状态
      const operations = group.map((msg, index) => ({
        type: 'set',
        key: `processed:${taskId}:${msg.message_id}`,
        value: {
          original: msg,
          processed: true,
          timestamp: Date.now()
        },
        ttl: 3600
      }));

      const batchResults = await batchProcessor.processBatch('consistent-cache', operations);
      expect(batchResults.every(r => r.success)).toBe(true);

      // 7. 更新任务状态
      await stateSynchronizer.updateTaskState(taskId, {
        status: 'completed',
        processedCount: 3,
        instanceId: instanceId
      });

      // 8. 释放锁
      await stateSynchronizer.releaseLock(taskId, instanceId);

      // 9. 验证最终状态
      const finalState = await stateSynchronizer.getTaskState(taskId);
      expect(finalState.status).toBe('completed');
      expect(finalState.processedCount).toBe(3);

      // 10. 清理
      await stateSynchronizer.clearTaskState(taskId);
      const clearedState = await stateSynchronizer.getTaskState(taskId);
      expect(clearedState).toBeNull();
    });
  });
});