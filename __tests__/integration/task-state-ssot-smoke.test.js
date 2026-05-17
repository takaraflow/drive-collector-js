import { beforeEach, describe, expect, test, vi } from 'vitest';

const tasks = new Map();
const cacheStore = new Map();
const transitionLog = [];

const mediaMessage = {
  id: 9001,
  media: {
    document: {
      size: 1024,
      attributes: [{ className: 'DocumentAttributeFilename', fileName: 'smoke.mp4' }]
    }
  }
};

function clone(value) {
  return value ? { ...value } : value;
}

function seedTask() {
  tasks.clear();
  cacheStore.clear();
  transitionLog.length = 0;
  tasks.set('task-smoke', {
    id: 'task-smoke',
    user_id: 'user-smoke',
    chat_id: 'chat-smoke',
    msg_id: 7001,
    source_msg_id: mediaMessage.id,
    file_name: 'smoke.mp4',
    file_size: 1024,
    status: 'queued',
    error_msg: null,
    claimed_by: null,
    claim_lease_id: null,
    created_at: Date.now(),
    updated_at: Date.now()
  });
}

const d1Mock = {
  fetchOne: vi.fn(async (sql, params = []) => {
    if (sql.includes('SELECT id, status') && sql.includes('FROM tasks WHERE id = ?')) {
      const row = tasks.get(params[0]);
      return row ? {
        id: row.id,
        status: row.status,
        updated_at: row.updated_at,
        claimed_by: row.claimed_by,
        claim_lease_id: row.claim_lease_id
      } : null;
    }

    if (sql.includes('SELECT * FROM tasks WHERE id = ?')) {
      return clone(tasks.get(params[0])) || null;
    }

    return null;
  }),
  fetchAll: vi.fn(async (sql, params = []) => {
    if (sql.includes('WHERE msg_id = ?')) {
      return [...tasks.values()].filter(task => task.msg_id === params[0]).map(clone);
    }

    return [];
  }),
  run: vi.fn(async (sql, params = []) => {
    if (!sql.startsWith('UPDATE tasks SET')) {
      return { changes: 0 };
    }

    const targetStatus = params[0];
    const errorMsg = params[1];
    const updatedAt = params[2];
    const taskIdIndex = params.findIndex(value => tasks.has(value));
    const taskId = params[taskIdIndex];
    const expectedStatus = params[taskIdIndex + 1];
    const row = tasks.get(taskId);

    if (!row || row.status !== expectedStatus) {
      return { changes: 0 };
    }
    if (sql.includes('claimed_by = ?') && sql.includes('claim_lease_id = ?') && sql.includes('AND claimed_by = ?')) {
      const fenceOwner = params[taskIdIndex + 2];
      const fenceLease = params[taskIdIndex + 3];
      if (row.claimed_by !== fenceOwner || row.claim_lease_id !== fenceLease) {
        return { changes: 0 };
      }
    }

    const fromStatus = row.status;
    row.status = targetStatus;
    row.error_msg = errorMsg;
    row.updated_at = updatedAt;

    if (sql.includes('claimed_by = ?') && !sql.includes('AND claimed_by = ?')) {
      row.claimed_by = params[3];
      row.claim_lease_id = params[4] ?? null;
    } else if (sql.includes('claimed_by = NULL')) {
      row.claimed_by = null;
      row.claim_lease_id = null;
    }

    transitionLog.push({ taskId, fromStatus, toStatus: targetStatus });
    return { changes: 1 };
  }),
  batch: vi.fn()
};

vi.mock('../../src/services/d1.js', () => ({
  d1: d1Mock
}));

vi.mock('../../src/services/CacheService.js', () => ({
  cache: {
    get: vi.fn(async key => cacheStore.get(key) || null),
    set: vi.fn(async (key, value) => {
      cacheStore.set(key, value);
      return true;
    }),
    delete: vi.fn(async key => {
      cacheStore.delete(key);
      return true;
    }),
    listKeys: vi.fn(async prefix => [...cacheStore.keys()].filter(key => key.startsWith(prefix)))
  }
}));

vi.mock('../../src/services/ConsistentCache.js', () => ({
  consistentCache: {
    get: vi.fn(async key => cacheStore.get(`consistent:${key}`) || null),
    set: vi.fn(async (key, value) => {
      cacheStore.set(`consistent:${key}`, value);
      return true;
    }),
    delete: vi.fn(async key => {
      cacheStore.delete(`consistent:${key}`);
      return true;
    })
  }
}));

vi.mock('../../src/services/StateSynchronizer.js', () => ({
  stateSynchronizer: {
    getTaskState: vi.fn(async taskId => cacheStore.get(`sync:${taskId}`) || null),
    updateTaskState: vi.fn(async (taskId, value) => {
      cacheStore.set(`sync:${taskId}`, value);
      return true;
    }),
    clearTaskState: vi.fn(async taskId => {
      cacheStore.delete(`sync:${taskId}`);
      return true;
    })
  }
}));

vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn(() => ({
    downloadDir: '/tmp/drive-collector-ssot-smoke',
    remoteFolder: '/smoke',
    remoteName: 'drive',
    streamForwarding: { enabled: false },
    oss: {}
  }))
}));

vi.mock('../../src/services/telegram.js', () => ({
  client: {
    getMessages: vi.fn(async () => [mediaMessage]),
    editMessage: vi.fn(),
    sendMessage: vi.fn(),
    connected: true
  }
}));

const getRemoteFileInfo = vi.fn();
vi.mock('../../src/services/rclone.js', () => ({
  CloudTool: {
    getRemoteFileInfo,
    _getUploadPath: vi.fn(async () => '/smoke'),
    uploadFile: vi.fn(async () => ({ success: true })),
    listRemoteFiles: vi.fn(async () => [])
  }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    instanceId: 'smoke-instance',
    getInstanceId: vi.fn(() => 'smoke-instance'),
    hasLock: vi.fn(async () => true),
    getLockLease: vi.fn(async () => ({ instanceId: 'smoke-instance', leaseId: 'smoke-lease' })),
    isLockLeaseCurrent: vi.fn(async () => true),
    acquireTaskLock: vi.fn(async () => true),
    releaseTaskLock: vi.fn(async () => true),
    getActiveInstances: vi.fn(async () => [])
  }
}));

const enqueueUploadTask = vi.fn(async () => ({ success: true }));
vi.mock('../../src/services/QueueService.js', () => ({
  queueService: {
    enqueueDownloadTask: vi.fn(async () => ({ success: true })),
    enqueueUploadTask,
    verifyWebhookSignature: vi.fn(async () => true)
  }
}));

vi.mock('../../src/utils/common.js', () => ({
  getMediaInfo: vi.fn(() => ({ name: 'smoke.mp4', size: 1024 })),
  updateStatus: vi.fn(async () => true),
  escapeHTML: value => value,
  safeEdit: vi.fn(async () => true)
}));

vi.mock('../../src/utils/limiter.js', () => ({
  runBotTask: vi.fn(fn => fn()),
  runMtprotoTask: vi.fn(fn => fn()),
  runBotTaskWithRetry: vi.fn(fn => fn()),
  runMtprotoTaskWithRetry: vi.fn(fn => fn()),
  runMtprotoFileTaskWithRetry: vi.fn(fn => fn()),
  PRIORITY: { UI: 20, HIGH: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 }
}));

vi.mock('../../src/ui/templates.js', () => ({
  UIHelper: {
    renderProgress: vi.fn(() => 'progress'),
    renderBatchMonitor: vi.fn(() => ({ text: 'batch monitor' }))
  }
}));

vi.mock('../../src/modules/AuthGuard.js', () => ({
  AuthGuard: { can: vi.fn(async () => false) }
}));

vi.mock('../../src/services/oss.js', () => ({
  ossService: { upload: vi.fn(async () => ({ success: true })) }
}));

vi.mock('../../src/services/StreamTransferService.js', () => ({
  streamTransferService: {}
}));

vi.mock('../../src/services/logger/index.js', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withModule: vi.fn().mockReturnThis(),
    withContext: vi.fn().mockReturnThis()
  };
  return { logger: log, default: log };
});

vi.mock('../../src/locales/zh-CN.js', () => ({
  STRINGS: {
    task: {
      downloading: 'downloading',
      uploading: 'uploading',
      downloaded_waiting_upload: 'downloaded {name}',
      success_sec_transfer: 'success {name} {folder}',
      failed_validation: 'failed validation {name}',
      failed_upload: 'failed upload {reason}',
      verifying: 'verifying',
      cancelled: 'cancelled',
      error_prefix: 'error: ',
      parse_failed: 'parse failed'
    }
  },
  format: vi.fn((template, values = {}) =>
    Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)
  )
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 1024 })),
    promises: {
      stat: vi.fn(async () => ({ size: 1024 })),
      unlink: vi.fn(async () => true)
    },
    unlinkSync: vi.fn()
  }
}));

const { TaskManager } = await import('../../src/processor/TaskManager.js');

describe('Task state SSOT smoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedTask();
    TaskManager.activeProcessors.clear();
    TaskManager.inFlightTasks.clear();
    TaskManager.cancelledTaskIds.clear();
    getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: 'smoke.mp4', Size: 1024 });
  });

  test('should close the queued-to-completed webhook chain through the repository state machine', async () => {
    const downloadResult = await TaskManager.handleDownloadWebhook('task-smoke');
    expect(downloadResult).toEqual({ success: true, statusCode: 200 });
    expect(tasks.get('task-smoke').status).toBe('downloaded');
    expect(enqueueUploadTask).toHaveBeenCalledWith('task-smoke', expect.objectContaining({
      userId: 'user-smoke',
      chatId: 'chat-smoke',
      msgId: 7001
    }));

    const uploadResult = await TaskManager.handleUploadWebhook('task-smoke');
    expect(uploadResult).toEqual({ success: true, statusCode: 200 });

    expect(tasks.get('task-smoke')).toMatchObject({
      status: 'completed',
      error_msg: null,
      claimed_by: null
    });
    expect(transitionLog.map(entry => `${entry.fromStatus}->${entry.toStatus}`)).toEqual([
      'queued->downloading',
      'downloading->downloading',
      'downloading->downloaded',
      'downloaded->uploading',
      'uploading->completed'
    ]);
    expect(cacheStore.has('task_status:task-smoke')).toBe(false);
    expect(cacheStore.has('consistent:task:task-smoke')).toBe(false);
    expect(cacheStore.has('sync:task-smoke')).toBe(false);
  });
});
