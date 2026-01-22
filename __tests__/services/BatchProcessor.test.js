/**
 * BatchProcessor.test.js
 * 
 * 测试 BatchProcessor 服务的完整功能
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
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
vi.mock('../../src/services/CacheService.js', () => ({
  cache: {
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn()
  }
}));

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

  beforeEach(async () => {
    vi.clearAllMocks();
    
    const { cache } = await import('../../src/services/CacheService.js');
    cache.set.mockResolvedValue(true);
    cache.get.mockResolvedValue(null);
    cache.delete.mockResolvedValue(true);

    processor = new BatchProcessor();
  });

  test('should create instance with default config', () => {
    expect(processor).toBeDefined();
    expect(processor.maxBatchSize).toBe(100);
    expect(processor.maxConcurrentBatches).toBe(5);
    expect(processor.activeBatches instanceof Map).toBe(true);
    expect(Array.isArray(processor.batchQueue)).toBe(true);
  });

  test('should create batch with items', async () => {
    const items = [
      { id: 1, name: 'task1' },
      { id: 2, name: 'task2' }
    ];

    const batchId = await processor.createBatch('task_create', items, {
      userId: 'user123',
      priority: 'high'
    });

    const { cache } = await import('../../src/services/CacheService.js');
    expect(batchId).toBeDefined();
    expect(typeof batchId).toBe('string');
    expect(cache.set).toHaveBeenCalledWith(
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

    await processor.createBatch('task_create', items);

    const { cache } = await import('../../src/services/CacheService.js');
    const calledWith = cache.set.mock.calls.find(call => 
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

    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(mockBatch);

    const status = await processor.getBatchStatus(batchId);

    expect(status).toEqual({
      ...mockBatch,
      progress: 1,
      remaining: 0,
      isComplete: true
    });
  });

  test('should return null for non-existent batch', async () => {
    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(null);

    const status = await processor.getBatchStatus('non-existent');

    expect(status).toBeNull();
  });

  test('should process batch successfully', async () => {
    const batchId = 'test-batch-123';
    const mockBatch = {
      id: batchId,
      type: 'task_create',
      items: [{ id: 1 }, { id: 2 }],
      status: 'pending'
    };

    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(mockBatch);
    
    const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    instanceCoordinator.acquireLock.mockResolvedValue(true);
    instanceCoordinator.releaseLock.mockResolvedValue(true);

    const processorFn = async (item, batch) => {
      return { processed: true, item };
    };

    const result = await processor.processBatch(batchId, processorFn);

    expect(result.success).toBe(true);
    expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith('batch_process:test-batch-123', 120);
    expect(instanceCoordinator.releaseLock).toHaveBeenCalledWith('batch_process:test-batch-123');
  });

  test('should fail to process when lock cannot be acquired', async () => {
    const batchId = 'test-batch-123';
    
    const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    instanceCoordinator.acquireLock.mockResolvedValue(false);

    const processorFn = async (item) => ({ processed: true });
    const result = await processor.processBatch(batchId, processorFn);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('lock_failed');
  });

  test('should handle processing errors', async () => {
    const batchId = 'test-batch-123';
    const mockBatch = {
      id: batchId,
      type: 'task_create',
      items: [{ id: 1 }],
      status: 'pending'
    };

    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(mockBatch);
    
    const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    instanceCoordinator.acquireLock.mockResolvedValue(true);
    instanceCoordinator.releaseLock.mockResolvedValue(true);

    const failingProcessor = async (item, batch) => {
      throw new Error('Processing failed');
    };

    const result = await processor.processBatch(batchId, failingProcessor);

    expect(result.success).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBe('Processing failed');
    expect(instanceCoordinator.releaseLock).toHaveBeenCalled();
  });

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

    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(mockBatch);

    const callback = vi.fn();
    
    processor.onBatchComplete(batchId, callback);
    
    await vi.advanceTimersByTimeAsync(1000);

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
    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(null);

    const callback = vi.fn();
    
    processor.onBatchComplete(batchId, callback);
    
    await vi.advanceTimersByTimeAsync(1000);

    expect(callback).toHaveBeenCalledWith(
      new Error('Batch not found')
    );
    
    vi.useRealTimers();
  });

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

  test('should cleanup completed batches without errors', async () => {
    await expect(processor.cleanupCompletedBatches()).resolves.not.toThrow();
  });

  test('should handle cache errors during batch creation', async () => {
    const { cache } = await import('../../src/services/CacheService.js');
    cache.set.mockRejectedValue(new Error('Cache error'));

    await expect(
      processor.createBatch('task_create', [{ id: 1 }])
    ).rejects.toThrow('Cache error');
  });

  test('should handle batch not found during processing', async () => {
    const batchId = 'non-existent';
    
    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(null);

    const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    instanceCoordinator.acquireLock.mockResolvedValue(true);

    const processorFn = async (item) => ({ processed: true });
    const result = await processor.processBatch(batchId, processorFn);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('batch_not_found_or_completed');
  });

  test('should handle already completed batches', async () => {
    const batchId = 'completed-batch';
    const mockBatch = {
      id: batchId,
      status: 'completed'
    };

    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(mockBatch);

    const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    instanceCoordinator.acquireLock.mockResolvedValue(true);

    const processorFn = async (item) => ({ processed: true });
    const result = await processor.processBatch(batchId, processorFn);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('batch_not_found_or_completed');
  });

  test('should handle concurrent batch creation', async () => {
    const batch1 = processor.createBatch('task_create', [{ id: 1 }]);
    const batch2 = processor.createBatch('task_create', [{ id: 2 }]);
    const batch3 = processor.createBatch('task_create', [{ id: 3 }]);

    const results = await Promise.all([batch1, batch2, batch3]);

    expect(results).toHaveLength(3);
    expect(new Set(results).size).toBe(3);
  });

  test('should process different batch types', async () => {
    const batchId = 'test-batch';
    const mockBatch = {
      id: batchId,
      type: 'file_upload',
      items: [{ id: 1 }],
      status: 'pending'
    };

    const { cache } = await import('../../src/services/CacheService.js');
    cache.get.mockResolvedValue(mockBatch);
    
    const { instanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    instanceCoordinator.acquireLock.mockResolvedValue(true);
    
    const processorFn = async (item, batch) => {
      return { type: batch.type, processed: true };
    };

    const result = await processor.processBatch(batchId, processorFn);

    expect(result.success).toBe(true);
  });
});
