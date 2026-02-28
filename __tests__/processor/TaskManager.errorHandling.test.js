import { TaskManager } from '../../src/processor/TaskManager.js';
import { instanceCoordinator } from '../../src/services/InstanceCoordinator.js';
import { TaskRepository } from '../../src/repositories/TaskRepository.js';
import { CloudTool } from '../../src/services/rclone.js';
import fs from 'fs';

// Mock dependencies
vi.mock('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    acquireTaskLock: vi.fn(),
    releaseTaskLock: vi.fn()
  }
}));

vi.mock('../../src/repositories/TaskRepository.js', () => ({
  TaskRepository: {
    updateStatus: vi.fn()
  }
}));

vi.mock('../../src/services/rclone.js', () => ({
  CloudTool: {
    getRemoteFileInfo: vi.fn(),
    uploadFile: vi.fn(),
    listRemoteFiles: vi.fn()
  }
}));

vi.mock('../../src/config/index.js', () => {
  const mockConfig = {
    remoteName: 'test',
    remoteFolder: 'test-folder',
    downloadDir: '/tmp/downloads'
  };
  return {
    config: mockConfig,
    getConfig: vi.fn(() => mockConfig)
  };
});

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    promises: {
      unlink: vi.fn()
    },
    unlinkSync: vi.fn()
  },
  existsSync: vi.fn(),
  statSync: vi.fn(),
  promises: {
    unlink: vi.fn()
  },
  unlinkSync: vi.fn()
}));

describe('TaskManager error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 模拟分布式锁获取成功
    instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
    // 模拟文件存在
    fs.existsSync.mockReturnValue(true);
    // 模拟文件状态
    fs.statSync.mockReturnValue({ size: 1024 });
    // 模拟远程文件不存在
    CloudTool.getRemoteFileInfo.mockResolvedValue(null);
    // 模拟远程文件列表获取成功
    CloudTool.listRemoteFiles.mockResolvedValue([]);
    // 模拟文件删除成功
    fs.promises.unlink.mockResolvedValue();
  });

  test('should handle network errors gracefully', async () => {
    const task = {
      id: 'test-task-1',
      chatId: '12345',
      msgId: 1,
      message: {
        media: {
          document: {
            fileName: 'test.txt'
          }
        }
      },
      localPath: '/tmp/test.txt'
    };

    // 模拟网络错误
    CloudTool.uploadFile.mockRejectedValue(new Error('Network error'));

    await TaskManager.uploadTask(task);

    // 验证任务状态被更新为失败
    expect(TaskRepository.updateStatus).toHaveBeenCalledWith(
      'test-task-1',
      'failed',
      'Network error'
    );
  });

  test('should handle file not found errors gracefully', async () => {
    const task = {
      id: 'test-task-2',
      chatId: '12345',
      msgId: 2,
      message: {
        media: {
          document: {
            fileName: 'test.txt'
          }
        }
      },
      localPath: '/tmp/test.txt'
    };

    // 模拟文件不存在
    fs.existsSync.mockReturnValue(false);

    await TaskManager.uploadTask(task);

    // 验证任务状态被更新为失败
    expect(TaskRepository.updateStatus).toHaveBeenCalledWith(
      'test-task-2',
      'failed',
      'Local file not found'
    );
  });

  test('should handle task cancellation gracefully', async () => {
    const task = {
      id: 'test-task-3',
      chatId: '12345',
      msgId: 3,
      message: {
        media: {
          document: {
            fileName: 'test.txt'
          }
        }
      },
      localPath: '/tmp/test.txt'
    };

    // 模拟任务取消
    TaskManager.cancelledTaskIds.add('test-task-3');

    await TaskManager.uploadTask(task);

    // 验证任务状态被更新为取消
    expect(TaskRepository.updateStatus).toHaveBeenCalledWith(
      'test-task-3',
      'cancelled',
      'CANCELLED'
    );
  });

  test('should handle upload failure gracefully', async () => {
    const task = {
      id: 'test-task-4',
      chatId: '12345',
      msgId: 4,
      message: {
        media: {
          document: {
            fileName: 'test.txt'
          }
        }
      },
      localPath: '/tmp/test.txt'
    };

    // 模拟上传失败
    CloudTool.uploadFile.mockResolvedValue({ success: false, error: 'Upload failed' });

    await TaskManager.uploadTask(task);

    // 验证任务状态被更新为失败
    expect(TaskRepository.updateStatus).toHaveBeenCalledWith(
      'test-task-4',
      'failed',
      'Upload failed'
    );
  });

  test('should handle validation failure gracefully', async () => {
    const task = {
      id: 'test-task-5',
      chatId: '12345',
      msgId: 5,
      message: {
        media: {
          document: {
            fileName: 'test.txt'
          }
        }
      },
      localPath: '/tmp/test.txt'
    };

    // 模拟上传成功但验证失败
    CloudTool.uploadFile.mockResolvedValue({ success: true });
    // 模拟远程文件不存在（验证失败），确保每次调用都返回null
    CloudTool.getRemoteFileInfo.mockResolvedValue(null);

    await TaskManager.uploadTask(task);

    // 验证任务状态被更新为失败
    expect(TaskRepository.updateStatus).toHaveBeenCalledWith(
      'test-task-5',
      'failed',
      expect.stringContaining('校验失败')
    );
  }, 60000); // 增加超时时间到60秒
});
