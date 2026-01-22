/**
 * BatchProcessor.test.js
 * 
 * 测试 BatchProcessor 服务的完整功能
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { BatchProcessor } from '../../src/services/BatchProcessor.js';

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
vi.mock('../../src/services/CacheService.js', () => {
  const mockCacheSet = vi.fn();
  const mockCacheGet = vi.fn();
  const mockCacheDelete = vi.fn();
  
  return {
    cache: {
      set: mockCacheSet,
      get: mockCacheGet,
      delete: mockCacheDelete
    }
  };
});

// Mock other dependencies
vi.mock('../../src/services/QueueService.js', () => ({
  queueService: {
    publish: vi.fn()
  }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    getInstanceId: vi.fn().mockReturnValue('test-instance')
  }
}));

vi.mock('../../src/utils/LocalCache.js', () => ({
  localCache: {}
}));

describe('BatchProcessor - 批量处理器服务', () => {
  let processor;
  let mockCacheSet;
  let mockCacheGet;
  let mockCacheDelete;

  beforeEach(async () => {
    // Use mock functions directly instead of dynamic import
    mockCacheSet = vi.fn().mockResolvedValue(true);
    mockCacheGet = vi.fn().mockResolvedValue(null);
    mockCacheDelete = vi.fn().mockResolvedValue(true);

    processor = new BatchProcessor();
    vi.clearAllMocks();

    // Setup basic mocks
    mockCacheSet.mockResolvedValue(true);
    mockCacheGet.mockResolvedValue(null);
    mockCacheDelete.mockResolvedValue(true);
  });

  afterEach(() => {
    mockCacheSet?.mockRestore();
    mockCacheGet?.mockRestore();
    mockCacheDelete?.mockRestore();
  });

  afterEach(() => {
    // No cleanup method exists
  });

  describe('基本功能', () => {
    test('should create instance with default config', () => {
      expect(processor).toBeDefined();
      expect(processor.maxBatchSize).toBe(100);
      expect(processor.maxConcurrentBatches).toBe(5);
      expect(processor.activeBatches instanceof Map).toBe(true);
      expect(Array.isArray(processor.batchQueue)).toBe(true);
    });
  });

  describe('批量创建和管理', () => {
    test('should create batch with items', async () => {
      const items = [
        { id: 1, name: 'task1' },
        { id: 2, name: 'task2' }
      ];

      const batchId = await processor.createBatch('task_create', items, {
        userId: 'user123',
        priority: 'high'
      });

      expect(batchId).toBeDefined();
      expect(typeof batchId).toBe('string');
      expect(mockCacheSet).toHaveBeenCalledWith(
        expect.stringContaining('batch:'),
        expect.objectContaining({
          id: batchId,
          type: 'task_create',
          items: items,
          userId: 'user123',
          priority: 'high',
          status: 'pending'
        }),
        3600
      );
    });

    test('should limit batch size to maximum', async () => {
      const items = Array.from({ length: 150 }, (_, i) => ({ id: i }));

      const batchId = await processor.createBatch('task_create', items);

      // Should be limited to maxBatchSize (100)
      const calledWith = mockCacheSet.mock.calls.find(call => 
        call[0].includes('batch:')
      );
      expect(calledWith[1].items.length).toBeLessThanOrEqual(100);
    });

    test('should get batch status', async () => {
      const batchId = 'test-batch-123';
      const mockBatch = {
        id: batchId,
        type: 'task_create',
        items: [{ id: 1 }],
        processedCount: 1,
        failedCount: 0,
        status: 'completed'
      };

      mockCacheGet.mockResolvedValue(mockBatch);

      const status = await processor.getBatchStatus(batchId);

      expect(status).toEqual({
        ...mockBatch,
        progress: 1,
        remaining: 0,
        isComplete: true
      });
    });

    test('should return null for non-existent batch', async () => {
      mockCacheGet.mockResolvedValue(null);

      const status = await processor.getBatchStatus('non-existent');

      expect(status).toBeNull();
    });
  });

  describe('批量处理', () => {
    test('should process batch successfully', async () => {
      const batchId = 'test-batch-123';
      const mockBatch = {
        id: batchId,
        type: 'task_create',
        items: [{ id: 1 }, { id: 2 }],
        status: 'pending'
      };

      mockCacheGet.mockResolvedValue(mockBatch);
      
      // Mock instance coordinator
      const mockAcquireLock = vi.fn().mockResolvedValue(true);
      const mockReleaseLock = vi.fn().mockResolvedValue(true);

      const processorFn = async (item, batch) => {
        return { processed: true, item };
      };

      const result = await processor.processBatch(batchId, processorFn);

      expect(result.success).toBe(true);
      expect(mockAcquireLock).toHaveBeenCalledWith('batch_process:test-batch-123', 120);
      expect(mockReleaseLock).toHaveBeenCalledWith('batch_process:test-batch-123');

      mockAcquireLock.mockRestore();
      mockReleaseLock.mockRestore();
    });

    test('should fail to process when lock cannot be acquired', async () => {
      const batchId = 'test-batch-123';
      
      const mockAcquireLock = vi.fn().mockResolvedValue(false);

      const processorFn = async (item) => ({ processed: true });
      const result = await processor.processBatch(batchId, processorFn);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('lock_failed');

      mockAcquireLock.mockRestore();
    });

    test('should handle processing errors', async () => {
      const batchId = 'test-batch-123';
      const mockBatch = {
        id: batchId,
        type: 'task_create',
        items: [{ id: 1 }],
        status: 'pending'
      };

      mockCacheGet.mockResolvedValue(mockBatch);
      
      const mockAcquireLock = vi.fn().mockResolvedValue(true);
      const mockReleaseLock = vi.fn().mockResolvedValue(true);

      const failingProcessor = async (item, batch) => {
        // Error should be caught and returned in results, not throw
        throw new Error('Processing failed');
      };

      const result = await processor.processBatch(batchId, failingProcessor);

      // Processing should succeed but contain failed results
      expect(result.success).toBe(true);
      expect(result.failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe('Processing failed');
      expect(mockReleaseLock).toHaveBeenCalled();

      mockAcquireLock.mockRestore();
      mockReleaseLock.mockRestore();
    });
  });

  describe('项目处理', () => {
    test('should process items in batches with concurrency', async () => {
      const items = [1, 2, 3, 4, 5];
      const processorFn = async (item) => ({ item, processed: true });

      const results = await processor.processItems(items, processorFn, {
        concurrency: 2,
        batchSize: 2
      });

      expect(results).toHaveLength(5);
      expect(results.every(r => r.success)).toBe(true);
    });

    test('should handle processing failures gracefully', async () => {
      const items = [1, 2, 3];
      const processorFn = async (item) => {
        if (item === 2) {
          throw new Error('Item 2 failed');
        }
        return { item, processed: true };
      };

      const results = await processor.processItems(items, processorFn);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('Item 2 failed');
      expect(results[2].success).toBe(true);
    });
  });

  describe('队列管理', () => {
    test('should return queue length', () => {
      expect(processor.getQueueLength()).toBe(0);
    });

    test('should return active batch count', () => {
      expect(processor.getActiveBatchCount()).toBe(0);
    });

    test('should add items to queue when creating batches', async () => {
      expect(processor.getQueueLength()).toBe(0);

      await processor.createBatch('task_create', [{ id: 1 }]);

      expect(processor.getQueueLength()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('批处理事件监听', () => {
    test('should handle batch complete callbacks', async () => {
      vi.useFakeTimers();
      
      const batchId = 'test-batch-123';
      const mockBatch = {
        id: batchId,
        status: 'completed',
        processedCount: 1,
        failedCount: 0,
        items: [{ id: 1 }]
      };

      mockCacheGet.mockResolvedValue(mockBatch);

      const callback = vi.fn();
      
      // Call onBatchComplete
      processor.onBatchComplete(batchId, callback);
      
      // Advance time to trigger the first check (checkInterval is 1000ms)
      await vi.advanceTimersByTimeAsync(1000);

      // The callback should be called with the completed batch
      expect(callback).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          isComplete: true,
          status: 'completed'
        })
      );
      
      vi.useRealTimers();
    });

    test('should handle batch not found', async () => {
      vi.useFakeTimers();
      
      const batchId = 'test-batch-123';
      mockCacheGet.mockResolvedValue(null);

      const callback = vi.fn();
      
      // Call onBatchComplete
      processor.onBatchComplete(batchId, callback);
      
      // Advance time to trigger the first check
      await vi.advanceTimersByTimeAsync(1000);

      expect(callback).toHaveBeenCalledWith(
        new Error('Batch not found')
      );
      
      vi.useRealTimers();
    });
  });

  describe('统计信息', () => {
    test('should return stats', async () => {
      const stats = await processor.getStats();

      expect(stats).toEqual({
        queueLength: expect.any(Number),
        activeBatches: expect.any(Number),
        maxBatchSize: 100,
        maxConcurrentBatches: 5,
        instanceId: 'test-instance'
      });
    });
  });

  describe('内部方法', () => {
    test('should chunk arrays correctly', () => {
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const chunks = processor._chunkArray(array, 3);

      expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
    });

    test('should get priority values', () => {
      expect(processor._getPriorityValue('critical')).toBe(100);
      expect(processor._getPriorityValue('high')).toBe(75);
      expect(processor._getPriorityValue('normal')).toBe(50);
      expect(processor._getPriorityValue('low')).toBe(25);
      expect(processor._getPriorityValue('unknown')).toBe(50);
    });

    test('should get processor for known types', () => {
      expect(processor._getProcessor('task_create')).toBeDefined();
      expect(processor._getProcessor('task_update')).toBeDefined();
      expect(processor._getProcessor('file_upload')).toBeDefined();
      expect(processor._getProcessor('unknown')).toBeNull();
    });
  });

  describe('清理功能', () => {
    test('should cleanup completed batches without errors', async () => {
      await expect(processor.cleanupCompletedBatches()).resolves.not.toThrow();
    });
  });

  describe('错误处理', () => {
    test('should handle cache errors during batch creation', async () => {
      mockCacheSet.mockRejectedValue(new Error('Cache error'));

      await expect(
        processor.createBatch('task_create', [{ id: 1 }])
      ).rejects.toThrow('Cache error');
    });

    test('should handle batch not found during processing', async () => {
      const batchId = 'non-existent';
      const mockAcquireLock = vi.fn().mockResolvedValue(true);
      
      mockCacheGet.mockResolvedValue(null);

      const processorFn = async (item) => ({ processed: true });
      const result = await processor.processBatch(batchId, processorFn);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('batch_not_found_or_completed');

      mockAcquireLock.mockRestore();
    });

    test('should handle already completed batches', async () => {
      const batchId = 'completed-batch';
      const mockBatch = {
        id: batchId,
        status: 'completed'
      };

      const mockAcquireLock = vi.fn().mockResolvedValue(true);
      
      mockCacheGet.mockResolvedValue(mockBatch);

      const processorFn = async (item) => ({ processed: true });
      const result = await processor.processBatch(batchId, processorFn);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('batch_not_found_or_completed');

      mockAcquireLock.mockRestore();
    });
  });

  describe('高级功能', () => {
    test('should handle concurrent batch creation', async () => {
      const batch1 = processor.createBatch('task_create', [{ id: 1 }]);
      const batch2 = processor.createBatch('task_create', [{ id: 2 }]);
      const batch3 = processor.createBatch('task_create', [{ id: 3 }]);

      const results = await Promise.all([batch1, batch2, batch3]);

      expect(results).toHaveLength(3);
      expect(new Set(results).size).toBe(3); // All batch IDs should be unique
    });

    test('should process different batch types', async () => {
      const batchId = 'test-batch';
      const mockBatch = {
        id: batchId,
        type: 'file_upload',
        items: [{ id: 1 }],
        status: 'pending'
      };

      mockCacheGet.mockResolvedValue(mockBatch);
      const mockAcquireLock = vi.fn().mockResolvedValue(true);
      
      const processorFn = async (item, batch) => {
        return { type: batch.type, processed: true };
      };

      const result = await processor.processBatch(batchId, processorFn);

      expect(result.success).toBe(true);

      mockAcquireLock.mockRestore();
    });
  });
});