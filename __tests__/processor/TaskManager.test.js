import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock all external dependencies
jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    default: {
        sendMessage: jest.fn().mockResolvedValue(true),
        editMessageText: jest.fn().mockResolvedValue(true),
        sendChatAction: jest.fn().mockResolvedValue(true),
    },
    client: {
        getMessages: jest.fn().mockResolvedValue([]),
        sendMessage: jest.fn().mockResolvedValue(true),
        downloadMedia: jest.fn().mockResolvedValue(true),
        connected: true,
    }
}));

jest.unstable_mockModule('../../src/services/oss.js', () => ({
    default: {
        uploadFile: jest.fn().mockResolvedValue({ url: 'https://example.com/file.mp4' }),
    },
    ossService: {
        upload: jest.fn().mockResolvedValue({ success: true }),
    }
}));

jest.unstable_mockModule('../../src/services/rclone.js', () => ({
    default: {
        uploadFile: jest.fn().mockResolvedValue({ url: 'https://example.com/file.mp4' }),
    },
    CloudTool: {
        getRemoteFileInfo: jest.fn().mockResolvedValue(null),
        uploadFile: jest.fn().mockResolvedValue({ success: true }),
        listRemoteFiles: jest.fn().mockResolvedValue([]),
    }
}));

jest.unstable_mockModule('../../src/services/CacheService.js', () => ({
    cache: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(true),
        delete: jest.fn().mockResolvedValue(true),
    }
}));

jest.unstable_mockModule('../../src/services/d1.js', () => ({
    d1: {
        prepare: jest.fn().mockReturnThis(),
        bind: jest.fn().mockReturnThis(),
        run: jest.fn().mockResolvedValue({ success: true }),
        all: jest.fn().mockResolvedValue({ results: [] }),
        first: jest.fn().mockResolvedValue(null),
        batch: jest.fn().mockResolvedValue([{ success: true }]),
    }
}));

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
    default: {
        getInstanceId: jest.fn().mockReturnValue('test-instance'),
        isPrimary: jest.fn().mockReturnValue(true),
        acquireLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
        hasLock: jest.fn().mockResolvedValue(true),
        acquireTaskLock: jest.fn().mockResolvedValue(true),
        releaseTaskLock: jest.fn().mockResolvedValue(true),
    },
    instanceCoordinator: {
        getInstanceId: jest.fn().mockReturnValue('test-instance'),
        isPrimary: jest.fn().mockReturnValue(true),
        acquireLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(true),
        hasLock: jest.fn().mockResolvedValue(true),
        acquireTaskLock: jest.fn().mockResolvedValue(true),
        releaseTaskLock: jest.fn().mockResolvedValue(true),
    }
}));

jest.unstable_mockModule('../../src/services/QStashService.js', () => ({
    default: {
        publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
        subscribe: jest.fn().mockResolvedValue({}),
        enqueueDownloadTask: jest.fn().mockResolvedValue(true),
        enqueueUploadTask: jest.fn().mockResolvedValue(true),
    },
    qstashService: {
        publish: jest.fn().mockResolvedValue({ messageId: 'msg-123' }),
        subscribe: jest.fn().mockResolvedValue({}),
        enqueueDownloadTask: jest.fn().mockResolvedValue(true),
        enqueueUploadTask: jest.fn().mockResolvedValue(true),
    }
}));

jest.unstable_mockModule('../../src/utils/limiter.js', () => ({
    handle429Error: jest.fn((fn) => fn()),
    checkCooling: jest.fn().mockResolvedValue(false),
    runBotTask: jest.fn((fn) => fn()),
    runMtprotoTask: jest.fn((fn) => fn()),
    runBotTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: jest.fn((fn) => fn()),
    PRIORITY: { UI: 20, HIGH: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 }
}));

// Import after mocking
const { TaskManager } = await import('../../src/processor/TaskManager.js');

describe('TaskManager', () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        // Reset static properties
        TaskManager.waitingTasks = [];
        TaskManager.processingTasks = new Map();
        TaskManager.completedTasks = [];
        TaskManager.currentTask = null;
        TaskManager.waitingUploadTasks = [];
        TaskManager.processingUploadTasks = new Set();
    });

    describe('static methods', () => {
        it('should have correct initial state', () => {
            expect(TaskManager.getProcessingCount()).toBe(0);
            expect(TaskManager.getWaitingCount()).toBe(0);
        });

        it('should track processing count correctly', async () => {
            // Simulate a task being processed
            TaskManager.currentTask = { id: 'test' };
            expect(TaskManager.getProcessingCount()).toBe(1);
            
            TaskManager.currentTask = null;
            expect(TaskManager.getProcessingCount()).toBe(0);
        });

        it('should track waiting count correctly', () => {
            TaskManager.waitingTasks = [{ id: 't1' }, { id: 't2' }];
            TaskManager.waitingUploadTasks = [{ id: 't3' }];
            
            expect(TaskManager.getWaitingCount()).toBe(3);
        });

        it('should handle batchUpdateStatus with empty updates', async () => {
            const { d1 } = await import('../../src/services/d1.js');
            
            await TaskManager.batchUpdateStatus([]);
            
            expect(d1.batch).not.toHaveBeenCalled();
        });

        it('should handle batchUpdateStatus with updates', async () => {
            const { d1 } = await import('../../src/services/d1.js');
            
            const updates = [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'failed', error: 'Test error' }
            ];
            
            await TaskManager.batchUpdateStatus(updates);
            
            expect(d1.batch).toHaveBeenCalled();
        });
    });

    describe('queue management', () => {
        it('should add tasks to waiting queue', () => {
            const task1 = { id: 't1', userId: 'u1' };
            const task2 = { id: 't2', userId: 'u2' };
            
            TaskManager.waitingTasks.push(task1, task2);
            
            expect(TaskManager.getWaitingCount()).toBe(2);
        });

        it('should track processing tasks', () => {
            const task = { id: 't1', userId: 'u1' };
            
            TaskManager.currentTask = task;
            TaskManager.processingTasks.set('t1', task);
            
            expect(TaskManager.getProcessingCount()).toBe(1);
        });
    });
});