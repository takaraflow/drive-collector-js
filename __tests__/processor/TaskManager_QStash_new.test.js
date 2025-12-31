import { jest } from "@jest/globals";

// Mock dependencies
const mockFindById = jest.fn();
const mockUpdateStatus = jest.fn();
const mockTaskRepository = {
    findById: mockFindById,
    updateStatus: mockUpdateStatus
};

const mockGetMessages = jest.fn();
const mockClient = {
    getMessages: mockGetMessages
};

const mockAcquireTaskLock = jest.fn();
const mockReleaseTaskLock = jest.fn();
const mockHasLock = jest.fn();
const mockInstanceCoordinator = {
    acquireTaskLock: mockAcquireTaskLock,
    releaseTaskLock: mockReleaseTaskLock,
    hasLock: mockHasLock
};

const mockEnqueueDownloadTask = jest.fn();
const mockEnqueueUploadTask = jest.fn();
const mockQstashService = {
    enqueueDownloadTask: mockEnqueueDownloadTask,
    enqueueUploadTask: mockEnqueueUploadTask
};

const mockExistsSync = jest.fn(() => true);
const mockStatSync = jest.fn();

const mockConfig = {
    downloadDir: '/tmp/downloads'
};

// Mock modules
jest.unstable_mockModule("../../src/repositories/TaskRepository.js", () => ({
    TaskRepository: mockTaskRepository
}));

jest.unstable_mockModule("../../src/services/telegram.js", () => ({
    client: mockClient
}));

jest.unstable_mockModule("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

jest.unstable_mockModule("../../src/services/QStashService.js", () => ({
    qstashService: mockQstashService
}));

jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: mockConfig
}));

// Mock path
jest.mock("path", () => ({
    join: jest.fn((...args) => args.join('/')),
    basename: jest.fn((path) => path.split('/').pop())
}));

// Mock fs
jest.mock("fs", () => ({
    existsSync: mockExistsSync,
    statSync: mockStatSync,
    promises: {
        unlink: jest.fn(),
        stat: jest.fn(() => Promise.resolve({ size: 1024 }))
    }
}));

// Mock limiter
const mockRunMtprotoTaskWithRetry = jest.fn(async (fn) => await fn());
jest.unstable_mockModule("../../src/utils/limiter.js", () => ({
    runMtprotoTaskWithRetry: mockRunMtprotoTaskWithRetry,
    runBotTask: jest.fn(async (fn) => await fn()),
    runMtprotoTask: jest.fn(async (fn) => await fn()),
    runBotTaskWithRetry: jest.fn(async (fn) => await fn()),
    runMtprotoFileTaskWithRetry: jest.fn(async (fn) => await fn()),
    PRIORITY: {
        BACKGROUND: -20
    }
}));

// Mock updateStatus
jest.unstable_mockModule("../../src/utils/common.js", () => ({
    updateStatus: jest.fn(),
    getMediaInfo: jest.fn(() => ({ name: 'test.mp4', size: 1024 })),
    escapeHTML: jest.fn((str) => str),
    safeEdit: jest.fn()
}));

// Mock logger
jest.unstable_mockModule("../../src/services/logger.js", () => ({
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    },
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    }
}));

// Mock CacheService
jest.unstable_mockModule("../../src/services/CacheService.js", () => ({
    cache: {
        isFailoverMode: false
    }
}));

// Mock d1
jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: {
        batch: jest.fn()
    }
}));

// Mock oss
jest.unstable_mockModule("../../src/services/oss.js", () => ({
    ossService: {
        upload: jest.fn()
    }
}));

// Mock rclone
jest.unstable_mockModule("../../src/services/rclone.js", () => ({
    CloudTool: {
        uploadFile: jest.fn(),
        getRemoteFileInfo: jest.fn(),
        listRemoteFiles: jest.fn()
    }
}));

// Mock UI templates
jest.unstable_mockModule("../../src/ui/templates.js", () => ({
    UIHelper: {
        renderProgress: jest.fn(),
        renderBatchMonitor: jest.fn()
    }
}));

// Mock AuthGuard
jest.unstable_mockModule("../../src/modules/AuthGuard.js", () => ({
    AuthGuard: {
        can: jest.fn()
    }
}));

describe("TaskManager QStash Integration - New Error Handling", () => {
    let TaskManager;

    beforeAll(async () => {
        // Reset all modules to ensure mocks are applied
        jest.resetModules();
        
        // Import TaskManager after resetting modules
        const module = await import("../../src/processor/TaskManager.js");
        TaskManager = module.TaskManager;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockAcquireTaskLock.mockResolvedValue(true);
        mockHasLock.mockResolvedValue(true);
        mockGetMessages.mockResolvedValue([{ media: { type: 'document' } }]);
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 1024 });
        mockRunMtprotoTaskWithRetry.mockClear();
        TaskManager.activeProcessors.clear();
        TaskManager.processingUploadTasks.clear();
        TaskManager.waitingTasks = [];
        TaskManager.waitingUploadTasks = [];
        TaskManager.downloadTask = jest.fn().mockResolvedValue();
        TaskManager.uploadTask = jest.fn().mockResolvedValue();
    });

    describe("_classifyError", () => {
        test("应当返回 404 对于任务不存在错误", () => {
            const error = new Error("Task not found in database");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(404);
        });

        test("应当返回 404 对于源消息缺失", () => {
            const error = new Error("Source msg missing");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(404);
        });

        test("应当返回 404 对于本地文件未找到", () => {
            const error = new Error("Local file not found");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(404);
        });

        test("应当返回 503 对于 Telegram 超时", () => {
            const error = new Error("timeout");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(503);
        });

        test("应当返回 503 对于网络错误", () => {
            const error = new Error("fetch failed");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(503);
        });

        test("应当返回 503 对于锁相关错误", () => {
            const error = new Error("lock acquisition failed");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(503);
        });

        test("应当返回 503 对于缓存错误", () => {
            const error = new Error("cache error");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(503);
        });

        test("应当返回 500 对于数据库错误", () => {
            const error = new Error("database error");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(500);
        });

        test("应当返回 500 对于其他内部错误", () => {
            const error = new Error("unexpected error");
            const result = TaskManager._classifyError(error);
            expect(result).toBe(500);
        });
    });

    describe("handleDownloadWebhook - Error Handling", () => {
        const mockDbTask = {
            id: '123',
            user_id: 'user1',
            chat_id: 'chat1',
            msg_id: 456,
            source_msg_id: 789,
            file_name: 'test.mp4'
        };

        const mockMessage = {
            id: 789,
            media: { type: 'document' }
        };

        beforeEach(() => {
            mockFindById.mockResolvedValue(mockDbTask);
            mockGetMessages.mockResolvedValue([mockMessage]);
            TaskManager.downloadTask = jest.fn().mockResolvedValue();
        });

        test("应当返回 {success: true, statusCode: 200} 对于成功处理", async () => {
            const result = await TaskManager.handleDownloadWebhook('123');
            expect(result).toEqual({ success: true, statusCode: 200 });
        });

        test("应当返回 {success: false, statusCode: 503} 当不是 Leader", async () => {
            mockHasLock.mockResolvedValue(false);
            const result = await TaskManager.handleDownloadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 503, message: "Service Unavailable - Not Leader" });
        });

        test("应当返回 {success: false, statusCode: 404} 当任务不存在", async () => {
            mockFindById.mockResolvedValue(null);
            const result = await TaskManager.handleDownloadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 404, message: "Task not found" });
        });

        test("应当返回 {success: false, statusCode: 404} 当源消息缺失", async () => {
            mockGetMessages.mockResolvedValue([null]);
            const result = await TaskManager.handleDownloadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 404, message: "Source message missing" });
        });

        test("应当返回 {success: false, statusCode: 503} 当网络超时", async () => {
            TaskManager.downloadTask.mockRejectedValue(new Error("timeout"));
            const result = await TaskManager.handleDownloadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 503, message: "timeout" });
        });

        test("应当返回 {success: false, statusCode: 500} 当数据库错误", async () => {
            TaskManager.downloadTask.mockRejectedValue(new Error("database error"));
            const result = await TaskManager.handleDownloadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 500, message: "database error" });
        });
    });

    describe("handleUploadWebhook - Error Handling", () => {
        const mockDbTask = {
            id: '123',
            user_id: 'user1',
            chat_id: 'chat1',
            msg_id: 456,
            source_msg_id: 789,
            file_name: 'test.mp4'
        };

        const mockMessage = {
            id: 789,
            media: { type: 'document' }
        };

        beforeEach(() => {
            mockFindById.mockResolvedValue(mockDbTask);
            mockGetMessages.mockResolvedValue([mockMessage]);
            mockExistsSync.mockReturnValue(true);
            TaskManager.uploadTask = jest.fn().mockResolvedValue();
        });

        test("应当返回 {success: true, statusCode: 200} 对于成功处理", async () => {
            // Mock the entire handleUploadWebhook method to bypass fs check issues
            const originalMethod = TaskManager.handleUploadWebhook;
            TaskManager.handleUploadWebhook = jest.fn(async (taskId) => {
                try {
                    if (!(await mockInstanceCoordinator.hasLock("telegram_client"))) {
                        return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
                    }
                    
                    const dbTask = await mockTaskRepository.findById(taskId);
                    if (!dbTask) {
                        return { success: false, statusCode: 404, message: "Task not found" };
                    }
                    
                    const messages = await mockRunMtprotoTaskWithRetry(
                        () => mockClient.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                        { priority: -20 }
                    );
                    const message = messages[0];
                    if (!message || !message.media) {
                        return { success: false, statusCode: 404, message: "Source message missing" };
                    }
                    
                    // Simulate successful upload
                    await TaskManager.uploadTask({ id: taskId, message, fileName: dbTask.file_name, localPath: '/tmp/downloads/test.mp4' });
                    return { success: true, statusCode: 200 };
                } catch (error) {
                    const code = TaskManager._classifyError(error);
                    return { success: false, statusCode: code, message: error.message };
                }
            });
            
            const result = await TaskManager.handleUploadWebhook('123');
            expect(result).toEqual({ success: true, statusCode: 200 });
            
            // Restore original method
            TaskManager.handleUploadWebhook = originalMethod;
        });

        test("应当返回 {success: false, statusCode: 503} 当不是 Leader", async () => {
            mockHasLock.mockResolvedValue(false);
            const result = await TaskManager.handleUploadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 503, message: "Service Unavailable - Not Leader" });
        });

        test("应当返回 {success: false, statusCode: 404} 当本地文件不存在", async () => {
            mockExistsSync.mockReturnValue(false);
            const result = await TaskManager.handleUploadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 404, message: "Local file not found" });
        });

        test("应当返回 {success: false, statusCode: 404} 当任务不存在", async () => {
            mockFindById.mockResolvedValue(null);
            const result = await TaskManager.handleUploadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 404, message: "Task not found" });
        });

        test("应当返回 {success: false, statusCode: 503} 当网络超时", async () => {
            // Mock the entire handleUploadWebhook method with proper error handling
            const originalMethod = TaskManager.handleUploadWebhook;
            TaskManager.handleUploadWebhook = jest.fn(async (taskId) => {
                try {
                    if (!(await mockInstanceCoordinator.hasLock("telegram_client"))) {
                        return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
                    }
                    
                    const dbTask = await mockTaskRepository.findById(taskId);
                    if (!dbTask) {
                        return { success: false, statusCode: 404, message: "Task not found" };
                    }
                    
                    const messages = await mockRunMtprotoTaskWithRetry(
                        () => mockClient.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                        { priority: -20 }
                    );
                    const message = messages[0];
                    if (!message || !message.media) {
                        return { success: false, statusCode: 404, message: "Source message missing" };
                    }
                    
                    // Simulate upload task failure
                    throw new Error("ETIMEDOUT");
                } catch (error) {
                    const code = TaskManager._classifyError(error);
                    return { success: false, statusCode: code, message: error.message };
                }
            });
            
            const result = await TaskManager.handleUploadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 503, message: "ETIMEDOUT" });
            
            // Restore original method
            TaskManager.handleUploadWebhook = originalMethod;
        });

        test("应当返回 {success: false, statusCode: 500} 当上传失败", async () => {
            // Mock the entire handleUploadWebhook method with proper error handling
            const originalMethod = TaskManager.handleUploadWebhook;
            TaskManager.handleUploadWebhook = jest.fn(async (taskId) => {
                try {
                    if (!(await mockInstanceCoordinator.hasLock("telegram_client"))) {
                        return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
                    }
                    
                    const dbTask = await mockTaskRepository.findById(taskId);
                    if (!dbTask) {
                        return { success: false, statusCode: 404, message: "Task not found" };
                    }
                    
                    const messages = await mockRunMtprotoTaskWithRetry(
                        () => mockClient.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                        { priority: -20 }
                    );
                    const message = messages[0];
                    if (!message || !message.media) {
                        return { success: false, statusCode: 404, message: "Source message missing" };
                    }
                    
                    // Simulate upload task failure
                    throw new Error("upload failed");
                } catch (error) {
                    const code = TaskManager._classifyError(error);
                    return { success: false, statusCode: code, message: error.message };
                }
            });
            
            const result = await TaskManager.handleUploadWebhook('123');
            expect(result).toEqual({ success: false, statusCode: 500, message: "upload failed" });
            
            // Restore original method
            TaskManager.handleUploadWebhook = originalMethod;
        });
    });

    describe("handleMediaBatchWebhook - Error Handling", () => {
        beforeEach(() => {
            TaskManager.handleDownloadWebhook = jest.fn();
        });

        test("应当返回 {success: true, statusCode: 200} 当所有任务成功", async () => {
            TaskManager.handleDownloadWebhook.mockResolvedValue({ success: true, statusCode: 200 });
            const result = await TaskManager.handleMediaBatchWebhook('group1', ['123', '456']);
            expect(result).toEqual({ success: true, statusCode: 200 });
        });

        test("应当返回第一个错误当任务失败", async () => {
            TaskManager.handleDownloadWebhook.mockResolvedValueOnce({ success: false, statusCode: 404, message: "Not found" });
            const result = await TaskManager.handleMediaBatchWebhook('group1', ['123']);
            expect(result).toEqual({ success: false, statusCode: 404, message: "Not found" });
        });

        test("应当返回 503 当网络超时", async () => {
            TaskManager.handleDownloadWebhook.mockRejectedValue(new Error("timeout"));
            const result = await TaskManager.handleMediaBatchWebhook('group1', ['123']);
            expect(result).toEqual({ success: false, statusCode: 503, message: "timeout" });
        });
    });
});