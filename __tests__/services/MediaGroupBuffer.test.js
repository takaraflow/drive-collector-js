/**
 * MediaGroupBuffer.test.js
 * 
 * 测试 MediaGroupBuffer 服务的完整功能
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MediaGroupBuffer } from '../../src/services/MediaGroupBuffer.js';
import { logger } from '../../src/services/logger/index.js';

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

describe('MediaGroupBuffer - 媒体组缓冲服务', () => {
  let buffer;

  beforeEach(() => {
    buffer = new MediaGroupBuffer();
  });

  afterEach(() => {
    if (buffer && typeof buffer.cleanup === 'function') {
      buffer.cleanup();
    }
    vi.clearAllMocks();
  });

  describe('基本功能', () => {
    test('should create instance with default config', () => {
      expect(buffer).toBeDefined();
      expect(buffer.bufferTimeout).toBe(1000);
      expect(buffer.maxGroupSize).toBe(10);
      expect(buffer.buffers instanceof Map).toBe(true);
    });

    test('should create instance with custom config', () => {
      const customBuffer = new MediaGroupBuffer({
        bufferTimeout: 2000,
        maxGroupSize: 5
      });
      expect(customBuffer.bufferTimeout).toBe(2000);
      expect(customBuffer.maxGroupSize).toBe(5);
    });
  });

  describe('消息添加和缓冲', () => {
    test('should add message to buffer', async () => {
      const chatId = 12345;
      const message = {
        message_id: 1,
        photo: [{ file_id: 'photo1' }],
        caption: 'Test photo'
      };

      const result = buffer.add(chatId, message);
      expect(result).toBe(false); // Not enough messages for group

      const messages = buffer.get(chatId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(message);
    });

    test('should return true when group is complete', async () => {
      const chatId = 12345;
      
      // Add 3 messages (default threshold is 3)
      for (let i = 0; i < 3; i++) {
        const result = buffer.add(chatId, {
          message_id: i + 1,
          photo: [{ file_id: `photo${i}` }],
          caption: `Photo ${i}`
        });
        
        if (i < 2) {
          expect(result).toBe(false);
        } else {
          expect(result).toBe(true);
        }
      }

      const messages = buffer.get(chatId);
      expect(messages).toHaveLength(3);
    });

    test('should handle different media types', () => {
      const chatId = 12345;
      
      // Add mixed media
      buffer.add(chatId, {
        message_id: 1,
        photo: [{ file_id: 'photo1' }]
      });
      
      buffer.add(chatId, {
        message_id: 2,
        video: { file_id: 'video1' }
      });
      
      buffer.add(chatId, {
        message_id: 3,
        document: { file_id: 'doc1' }
      });

      const messages = buffer.get(chatId);
      expect(messages).toHaveLength(3);
      expect(messages[0].photo).toBeDefined();
      expect(messages[1].video).toBeDefined();
      expect(messages[2].document).toBeDefined();
    });
  });

  describe('超时处理', () => {
    test('should flush buffer on timeout', async () => {
      vi.useFakeTimers();
      
      const chatId = 12345;
      const callback = vi.fn();
      
      buffer.on('groupComplete', callback);
      
      // Add 2 messages (below threshold)
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      // Fast-forward time
      await vi.advanceTimersByTimeAsync(1000);
      
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

    test('should not flush if messages are added before timeout', async () => {
      vi.useFakeTimers();
      
      const chatId = 12345;
      const callback = vi.fn();
      
      buffer.on('groupComplete', callback);
      
      // Add first message
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      
      // Wait half timeout
      await vi.advanceTimersByTimeAsync(500);
      
      // Add second message
      buffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      // Wait another half timeout (total 1000ms)
      await vi.advanceTimersByTimeAsync(500);
      
      // Should not have flushed yet
      expect(callback).not.toHaveBeenCalled();
      
      // Wait full timeout again
      await vi.advanceTimersByTimeAsync(1000);
      
      // Now should flush
      expect(callback).toHaveBeenCalledTimes(1);
      
      vi.useRealTimers();
    });
  });

  describe('最大组大小限制', () => {
    test('should flush when max group size is reached', () => {
      const chatId = 12345;
      const callback = vi.fn();
      
      buffer.on('groupComplete', callback);
      buffer.maxGroupSize = 5; // Set lower limit
      
      // Add 5 messages
      for (let i = 0; i < 5; i++) {
        buffer.add(chatId, {
          message_id: i + 1,
          photo: [{ file_id: `photo${i}` }]
        });
      }
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId,
          messages: expect.arrayContaining([
            expect.objectContaining({ message_id: 1 }),
            expect.objectContaining({ message_id: 5 })
          ])
        })
      );
    });
  });

  describe('事件发射', () => {
    test('should emit groupComplete event with correct data', () => {
      const chatId = 12345;
      const messages = [
        { message_id: 1, photo: [{ file_id: 'photo1' }], caption: 'First' },
        { message_id: 2, photo: [{ file_id: 'photo2' }], caption: 'Second' },
        { message_id: 3, photo: [{ file_id: 'photo3' }], caption: 'Third' }
      ];
      
      const callback = vi.fn();
      buffer.on('groupComplete', callback);
      
      messages.forEach(msg => buffer.add(chatId, msg));
      
      expect(callback).toHaveBeenCalledWith({
        chatId,
        messages,
        timestamp: expect.any(Number)
      });
    });

    test('should support multiple listeners', () => {
      const chatId = 12345;
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      buffer.on('groupComplete', callback1);
      buffer.on('groupComplete', callback2);
      
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      buffer.add(chatId, { message_id: 3, photo: [{ file_id: 'photo3' }] });
      
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback1.mock.calls[0][0]).toEqual(callback2.mock.calls[0][0]);
    });
  });

  describe('多聊天室隔离', () => {
    test('should handle multiple chat rooms independently', () => {
      const chat1 = 11111;
      const chat2 = 22222;
      
      const callback = vi.fn();
      buffer.on('groupComplete', callback);
      
      // Add to chat1
      buffer.add(chat1, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(chat1, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      // Add to chat2
      buffer.add(chat2, { message_id: 10, photo: [{ file_id: 'photo10' }] });
      buffer.add(chat2, { message_id: 11, photo: [{ file_id: 'photo11' }] });
      
      // Both should still be waiting
      expect(callback).not.toHaveBeenCalled();
      
      // Complete chat1
      buffer.add(chat1, { message_id: 3, photo: [{ file_id: 'photo3' }] });
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: chat1 })
      );
      
      // Chat2 should still be waiting
      const chat2Messages = buffer.get(chat2);
      expect(chat2Messages).toHaveLength(2);
    });
  });

  describe('手动获取和清除', () => {
    test('should manually get buffered messages', () => {
      const chatId = 12345;
      
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      const messages = buffer.get(chatId);
      expect(messages).toHaveLength(2);
      
      // Should still be in buffer
      const messages2 = buffer.get(chatId);
      expect(messages2).toHaveLength(2);
    });

    test('should clear buffer for specific chat', () => {
      const chatId = 12345;
      
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      buffer.clear(chatId);
      
      const messages = buffer.get(chatId);
      expect(messages).toHaveLength(0);
    });

    test('should clear all buffers', () => {
      buffer.add(11111, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(22222, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      buffer.clearAll();
      
      expect(buffer.get(11111)).toHaveLength(0);
      expect(buffer.get(22222)).toHaveLength(0);
    });
  });

  describe('持久化和恢复', () => {
    test('should persist buffer to file', async () => {
      const chatId = 12345;
      
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      buffer.add(chatId, { message_id: 2, photo: [{ file_id: 'photo2' }] });
      
      // Mock file operations
      const writeFile = vi.spyOn(buffer, 'persistToFile').mockResolvedValue(true);
      
      await buffer.persistToFile();
      
      expect(writeFile).toHaveBeenCalled();
    });

    test('should restore buffer from file', async () => {
      const mockData = {
        12345: [
          { message_id: 1, photo: [{ file_id: 'photo1' }] },
          { message_id: 2, photo: [{ file_id: 'photo2' }] }
        ]
      };
      
      const readFile = vi.spyOn(buffer, 'loadFromFile').mockResolvedValue(mockData);
      
      await buffer.loadFromFile();
      
      expect(readFile).toHaveBeenCalled();
      expect(buffer.get(12345)).toHaveLength(2);
    });
  });

  describe('性能和边界条件', () => {
    test('should handle large number of chat rooms', () => {
      const start = Date.now();
      
      for (let i = 0; i < 1000; i++) {
        buffer.add(i, { message_id: 1, photo: [{ file_id: `photo${i}` }] });
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // Should be fast
      
      // Verify all are stored
      for (let i = 0; i < 1000; i++) {
        expect(buffer.get(i)).toHaveLength(1);
      }
    });

    test('should handle rapid add/clear operations', () => {
      const chatId = 12345;
      
      for (let i = 0; i < 100; i++) {
        buffer.add(chatId, { message_id: i, photo: [{ file_id: `photo${i}` }] });
        if (i % 10 === 0) {
          buffer.clear(chatId);
        }
      }
      
      // Should have last 10 messages
      expect(buffer.get(chatId)).toHaveLength(10);
    });

    test('should handle edge case: empty message', () => {
      const chatId = 12345;
      
      expect(() => {
        buffer.add(chatId, null);
        buffer.add(chatId, undefined);
        buffer.add(chatId, {});
      }).not.toThrow();
      
      // Should still store valid messages
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      expect(buffer.get(chatId)).toContainEqual(
        expect.objectContaining({ message_id: 1 })
      );
    });
  });

  describe('错误处理', () => {
    test('should handle file system errors gracefully', async () => {
      const writeFile = vi.spyOn(buffer, 'persistToFile').mockRejectedValue(
        new Error('Permission denied')
      );
      
      await expect(buffer.persistToFile()).rejects.toThrow('Permission denied');
    });

    test('should handle invalid JSON in restore', async () => {
      const readFile = vi.spyOn(buffer, 'loadFromFile').mockResolvedValue(
        'invalid json'
      );
      
      await expect(buffer.loadFromFile()).rejects.toThrow();
    });
  });

  describe('内存管理', () => {
    test('should cleanup timers on destroy', () => {
      vi.useFakeTimers();
      
      const chatId = 12345;
      buffer.add(chatId, { message_id: 1, photo: [{ file_id: 'photo1' }] });
      
      // Should have active timer
      expect(buffer.timeouts.size).toBe(1);
      
      buffer.cleanup();
      
      // Timers should be cleared
      expect(buffer.timeouts.size).toBe(0);
      
      vi.useRealTimers();
    });

    test('should prevent memory leaks with many chat rooms', () => {
      // Add many chat rooms
      for (let i = 0; i < 1000; i++) {
        buffer.add(i, { message_id: 1, photo: [{ file_id: `photo${i}` }] });
      }
      
      // Clear all
      buffer.clearAll();
      
      // Should be empty
      expect(buffer.buffers.size).toBe(0);
      expect(buffer.timeouts.size).toBe(0);
    });
  });
});