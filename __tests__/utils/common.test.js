import { getMediaInfo, safeEdit, updateStatus } from '../src/utils/common.js';

// Mock external dependencies
jest.mock('../src/services/telegram.js', () => ({
  client: {
    editMessage: jest.fn()
  }
}));

jest.mock('../src/utils/limiter.js', () => ({
  runBotTask: jest.fn((fn) => fn())
}));

jest.mock('../src/locales/zh-CN.js', () => ({
  STRINGS: {
    task: {
      cancel_transfer_btn: 'Cancel Transfer',
      cancel_task_btn: 'Cancel Task'
    }
  }
}));

describe('Common Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMediaInfo', () => {
    test('extracts info from document media', () => {
      const media = {
        document: {
          attributes: [{ fileName: 'test.pdf' }],
          size: 1024
        }
      };

      const result = getMediaInfo(media);
      expect(result).toEqual({ name: 'test.pdf', size: 1024 });
    });

    test('extracts info from video media', () => {
      const media = {
        video: {
          attributes: [{ fileName: 'video.mp4' }],
          size: 2048
        }
      };

      const result = getMediaInfo(media);
      expect(result).toEqual({ name: 'video.mp4', size: 2048 });
    });

    test('extracts info from photo media', () => {
      const media = {
        photo: {
          sizes: [{ size: 512 }, { size: 1024 }]
        }
      };

      const result = getMediaInfo(media);
      expect(result).toEqual({ name: 'transfer_1234567890.jpg', size: 1024 });
    });

    test('generates filename for media without attributes', () => {
      const media = {
        document: {
          size: 1024
        }
      };

      // Mock Date.now
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => 1234567890000);

      const result = getMediaInfo(media);
      expect(result.name).toBe('transfer_1234567890.bin');

      Date.now = originalDateNow;
    });

    test('returns null for invalid media', () => {
      const result = getMediaInfo({ invalid: true });
      expect(result).toBeNull();
    });
  });

  describe('safeEdit', () => {
    test('calls editMessage with correct parameters', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      const mockLimiter = require('../src/utils/limiter.js');

      await safeEdit(123, 456, 'test message', null, 789);

      expect(mockLimiter.runBotTask).toHaveBeenCalledWith(
        expect.any(Function),
        789
      );
    });

    test('handles editMessage errors gracefully', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      mockClient.editMessage.mockRejectedValue(new Error('Edit failed'));

      // Should not throw
      await expect(safeEdit(123, 456, 'test')).resolves.not.toThrow();
    });
  });

  describe('updateStatus', () => {
    test('updates status with cancel button for active task', async () => {
      const task = {
        id: 'task1',
        chatId: 123,
        msgId: 456,
        userId: 789,
        proc: null // not a transfer task
      };

      await updateStatus(task, 'Processing...', false);

      expect(safeEdit).toHaveBeenCalledWith(
        123,
        456,
        'Processing...',
        expect.arrayContaining([
          expect.objectContaining({
            text: 'Cancel Task'
          })
        ]),
        789
      );
    });

    test('updates status without buttons for final status', async () => {
      const task = {
        id: 'task1',
        chatId: 123,
        msgId: 456,
        userId: 789
      };

      await updateStatus(task, 'Completed!', true);

      expect(safeEdit).toHaveBeenCalledWith(123, 456, 'Completed!', null, 789);
    });

    test('uses correct button text for transfer tasks', async () => {
      const task = {
        id: 'task1',
        chatId: 123,
        msgId: 456,
        userId: 789,
        proc: {} // transfer task
      };

      await updateStatus(task, 'Uploading...', false);

      expect(safeEdit).toHaveBeenCalledWith(
        123,
        456,
        'Uploading...',
        expect.arrayContaining([
          expect.objectContaining({
            text: 'Cancel Transfer'
          })
        ]),
        789
      );
    });
  });
});