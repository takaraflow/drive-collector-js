import { TaskManager } from '../src/core/TaskManager';

// Mock external dependencies
jest.mock('../src/services/telegram.js', () => ({
  client: {
    sendMessage: jest.fn(),
    editMessage: jest.fn(),
  },
}));

jest.mock('../src/services/rclone.js', () => ({
  CloudTool: {
    getRemoteFileInfo: jest.fn(),
    uploadFile: jest.fn(),
  },
}));

jest.mock('../src/utils/common.js', () => ({
  getMediaInfo: jest.fn(() => ({ name: 'test.mp4', size: 1000 })),
  updateStatus: jest.fn(),
}));

jest.mock('../src/utils/limiter.js', () => ({
  runBotTask: jest.fn((fn) => fn()),
  runMtprotoTask: jest.fn((fn) => fn()),
}));

jest.mock('../src/modules/AuthGuard.js', () => ({
  AuthGuard: {
    can: jest.fn(() => true),
  },
}));

jest.mock('../src/repositories/TaskRepository.js', () => ({
  TaskRepository: {
    create: jest.fn(),
    findById: jest.fn(),
    findByMsgId: jest.fn(() => []),
    updateStatus: jest.fn(),
    markCancelled: jest.fn(),
    findStalledTasks: jest.fn(() => []),
  },
}));

jest.mock('../src/ui/templates.js', () => ({
  UIHelper: {
    renderBatchMonitor: jest.fn(() => ({ text: 'monitor text' })),
    renderProgress: jest.fn(),
  },
}));

jest.mock('../src/locales/zh-CN.js', () => ({
  STRINGS: {
    task: {
      captured: 'Captured {{label}}',
      batch_captured: 'Batch captured {{count}}',
      queued: 'Queued {{rank}}',
      cancel_btn: 'Cancel',
      parse_failed: 'Parse failed',
      success: 'Success {{name}} {{folder}}',
      failed_upload: 'Failed {{reason}}',
      error_prefix: 'Error: ',
      cancelled: 'Cancelled',
      batch_monitor: 'Monitor {{current}}/{{total}} {{statusText}}',
      focus_downloading: 'Downloading {{name}}',
      focus_uploading: 'Uploading {{name}}',
      focus_completed: 'Completed {{name}}',
      focus_failed: 'Failed {{name}}',
    },
  },
  format: jest.fn((str, obj) => {
    return str.replace(/\{\{(\w+)\}\}/g, (match, key) => obj[key] || match);
  }),
}));

describe('TaskManager', () => {
  beforeEach(() => {
    // Reset static properties
    TaskManager.queue = { add: jest.fn() };
    TaskManager.waitingTasks = [];
    TaskManager.currentTask = null;
    TaskManager.monitorLocks = new Map();
  });

  describe('_createTaskObject', () => {
    test('creates task object correctly', () => {
      const task = TaskManager._createTaskObject('id1', 'user1', 'chat1', 'msg1', {
        media: { type: 'document' }
      });

      expect(task).toEqual({
        id: 'id1',
        userId: 'user1',
        chatId: 'chat1',
        msgId: 'msg1',
        message: { media: { type: 'document' } },
        fileName: 'test.mp4',
        lastText: '',
        isCancelled: false,
      });
    });

    test('handles string chatId', () => {
      const task = TaskManager._createTaskObject('id1', 'user1', 'chat1', 'msg1', {});

      expect(task.chatId).toBe('chat1');
    });
  });

  describe('updateQueueUI', () => {
    test('skips group tasks', () => {
      const mockTask = { isGroup: true, lastText: '', msgId: '123' };
      TaskManager.waitingTasks = [mockTask];

      // Mock updateStatus
      const mockUpdateStatus = jest.fn();
      global.updateStatus = mockUpdateStatus;

      TaskManager.updateQueueUI();

      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });

    test('updates non-group tasks', () => {
      const mockTask = { isGroup: false, lastText: '', msgId: '123' };
      TaskManager.waitingTasks = [mockTask];

      const { updateStatus } = require('../src/utils/common.js');
      updateStatus.mockResolvedValue();

      TaskManager.updateQueueUI();

      expect(updateStatus).toHaveBeenCalled();
    });
  });
});