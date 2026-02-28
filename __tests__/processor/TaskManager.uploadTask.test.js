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
    uploadFile: vi.fn()
  }
}));

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

describe('TaskManager uploadTask', () => {
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
    // 模拟上传成功
    CloudTool.uploadFile.mockResolvedValue({ success: true });
  });

  test('should properly release task lock in finally block', async () => {
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

    // 模拟文件删除成功
    fs.promises.unlink.mockResolvedValue();

    await TaskManager.uploadTask(task);

    // 验证分布式锁被释放
    expect(instanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('test-task-1');
  });

  test('should release task lock even when upload fails', async () => {
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

    // 模拟上传失败
    CloudTool.uploadFile.mockResolvedValue({ success: false, error: 'Upload failed' });

    await TaskManager.uploadTask(task);

    // 验证分布式锁被释放
    expect(instanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('test-task-2');
  });

  test('should release task lock even when exception is thrown', async () => {
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

    // 模拟上传过程中抛出异常
    CloudTool.uploadFile.mockRejectedValue(new Error('Upload error'));

    await TaskManager.uploadTask(task);

    // 验证分布式锁被释放
    expect(instanceCoordinator.releaseTaskLock).toHaveBeenCalledWith('test-task-3');
  });

  test('should clean up local file in finally block', async () => {
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

    // 模拟文件删除成功
    fs.promises.unlink.mockResolvedValue();

    await TaskManager.uploadTask(task);

    // 验证本地文件被删除
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/test.txt');
  });

  test('should clean up local file even when upload fails', async () => {
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

    // 模拟上传失败
    CloudTool.uploadFile.mockResolvedValue({ success: false, error: 'Upload failed' });
    // 模拟文件删除成功
    fs.promises.unlink.mockResolvedValue();

    await TaskManager.uploadTask(task);

    // 验证本地文件被删除
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/test.txt');
  });
});
