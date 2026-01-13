/**
 * MediaGroupBuffer_simple.test.js
 * 简化的分布式 MediaGroupBuffer 测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

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
vi.mock('../../src/services/DistributedLock.js', () => ({
  DistributedLock: class {
    constructor() {
      this.acquire = vi.fn();
      this.release = vi.fn();
      this.getLockStatus = vi.fn();
      this.getStats = vi.fn().mockResolvedValue({ total: 0, held: 0, expired: 0, local: 0 });
    }
  }
}));

// Mock TaskManager
vi.mock('../../src/processor/TaskManager.js', () => ({
  TaskManager: {
    addBatchTasks: vi.fn().mockResolvedValue(true)
  }
}));

describe('MediaGroupBuffer - 基本功能测试', () => {
  let MediaGroupBuffer;
  let cache;
  let TaskManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // 动态导入以应用 mock
    const module = await import('../../src/services/MediaGroupBuffer.js');
    MediaGroupBuffer = module.MediaGroupBuffer;
    cache = await import('../../src/services/CacheService.js').then(m => m.cache);
    TaskManager = await import('../../src/processor/TaskManager.js').then(m => m.TaskManager);
  });

  test('should create MediaGroupBuffer instance with correct configuration', () => {
    const buffer = new MediaGroupBuffer({
      instanceId: 'test-instance',
      bufferTimeout: 100,
      maxBatchSize: 3
    });

    expect(buffer).toBeDefined();
    expect(buffer.options.instanceId).toBe('test-instance');
    expect(buffer.options.bufferTimeout).toBe(100);
    expect(buffer.options.maxBatchSize).toBe(3);
    expect(buffer.persistKey).toBe('test-instance:media_group_buffer');
  });

  test('should handle message duplicate check', async () => {
    const buffer = new MediaGroupBuffer({ instanceId: 'test-instance' });
    
    // Mock duplicate message
    cache.get.mockImplementation((key) => {
      if (key.includes('processed_messages')) {
        return '1'; // Already processed
      }
      return null;
    });

    const message = { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123' };
    const result = await buffer.add(message, { id: 'target-1' }, 'user-1');

    expect(result.added).toBe(false);
    expect(result.reason).toBe('duplicate');
  });

  test('should acquire lock and buffer message', async () => {
    const buffer = new MediaGroupBuffer({ instanceId: 'test-instance' });
    
    // Mock successful lock acquisition
    const mockLock = buffer.distributedLock;
    mockLock.acquire.mockResolvedValue({ success: true, version: 'v1' });

    // Mock cache operations
    cache.get.mockImplementation((key) => {
      if (key.includes('processed_messages')) return null;
      return null;
    });
    cache.listKeys.mockResolvedValue([]);

    const message = { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123' };
    const result = await buffer.add(message, { id: 'target-1' }, 'user-1');

    expect(result.added).toBe(true);
    expect(mockLock.acquire).toHaveBeenCalledWith('group-123', 'test-instance');
  });

  test('should handle lock held by another instance', async () => {
    const buffer = new MediaGroupBuffer({ instanceId: 'test-instance' });
    
    // Mock lock held by another instance
    const mockLock = buffer.distributedLock;
    mockLock.acquire.mockResolvedValue({
      success: false,
      reason: 'lock_held',
      currentOwner: 'other-instance'
    });

    cache.get.mockReturnValue(null);

    const message = { id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123' };
    const result = await buffer.add(message, { id: 'target-1' }, 'user-1');

    expect(result.added).toBe(true);
    expect(result.reason).toBe('buffered_by_other_instance');
  });

  test('should persist and restore buffers', async () => {
    const buffer = new MediaGroupBuffer({ instanceId: 'test-instance' });

    // Mock persist data
    const mockData = {
      instanceId: 'test-instance',
      timestamp: Date.now(),
      buffers: [{
        gid: 'group-123',
        target: { id: 'target-1' },
        userId: 'user-1',
        messages: [{ id: 'msg-1', media: { file_id: 'photo1' }, groupedId: 'group-123', _seq: 1 }],
        createdAt: Date.now()
      }]
    };

    cache.get.mockResolvedValue(mockData);
    const mockLock = buffer.distributedLock;
    mockLock.acquire.mockResolvedValue({ success: true, version: 'v1' });
    mockLock.getLockStatus.mockResolvedValue({ status: 'held', owner: 'test-instance', version: 'v1' });
    cache.listKeys.mockResolvedValue([]);

    await buffer.restore();

    // 验证消息被重新添加
    expect(cache.set).toHaveBeenCalled();
  });

  test('should return correct status', async () => {
    const buffer = new MediaGroupBuffer({ instanceId: 'test-instance' });

    cache.listKeys.mockImplementation((pattern) => {
      if (pattern.includes(':buffer:*:meta')) {
        return ['test-instance:buffer:group-123:meta'];
      }
      if (pattern.includes(':msg:*')) {
        return ['test-instance:buffer:group-123:msg:msg-1'];
      }
      return [];
    });

    const status = await buffer.getStatus();

    expect(status.instanceId).toBe('test-instance');
    expect(status.activeBuffers).toBe(1);
    expect(status.bufferedMessages).toBe(1);
  });
});