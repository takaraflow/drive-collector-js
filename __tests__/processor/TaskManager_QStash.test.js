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
    existsSync: jest.fn(() => true),
    statSync: mockStatSync
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

describe("TaskManager QStash Integration", () => {
    let TaskManager;

    beforeAll(async () => {
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

    describe("_enqueueTask", () => {
        test("应当调用 qstashService.enqueueDownloadTask", async () => {
            const task = {
                id: '123',
                userId: 'user1',
                chatId: 'chat1',
                msgId: 456
            };

            await TaskManager._enqueueTask(task);

            expect(mockEnqueueDownloadTask).toHaveBeenCalledWith('123', {
                userId: 'user1',
                chatId: 'chat1',
                msgId: 456
            });
        });

        test("应当处理 enqueueDownloadTask 异常", async () => {
            mockEnqueueDownloadTask.mockRejectedValue(new Error('QStash error'));

            const task = { id: '123', userId: 'user1', chatId: 'chat1', msgId: 456 };
            
            // Should not throw, should handle gracefully
            await expect(TaskManager._enqueueTask(task)).resolves.toBeUndefined();
        });
    });

    describe("handleDownloadWebhook", () => {
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

        test("应当正确处理下载 Webhook", async () => {
            await TaskManager.handleDownloadWebhook('123');

            expect(mockFindById).toHaveBeenCalledWith('123');
            expect(mockGetMessages).toHaveBeenCalledWith('chat1', { ids: [789] });
            expect(TaskManager.downloadTask).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: '123',
                    userId: 'user1',
                    chatId: 'chat1',
                    msgId: 456,
                    message: mockMessage,
                    fileName: 'test.mp4'
                })
            );
        });

        test("应当处理任务不存在的情况", async () => {
            mockFindById.mockResolvedValue(null);

            await TaskManager.handleDownloadWebhook('123');

            expect(TaskManager.downloadTask).not.toHaveBeenCalled();
            // TaskManager just logs and returns, doesn't update status
            expect(mockUpdateStatus).not.toHaveBeenCalled();
        });
    });

    describe("handleUploadWebhook", () => {
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
            TaskManager.uploadTask = jest.fn().mockResolvedValue();
        });

        test("应当正确处理上传 Webhook", async () => {
            await TaskManager.handleUploadWebhook('123');

            expect(mockFindById).toHaveBeenCalledWith('123');
        });

        test("应当处理任务不存在的情况", async () => {
            mockFindById.mockResolvedValue(null);

            await TaskManager.handleUploadWebhook('123');

            expect(TaskManager.uploadTask).not.toHaveBeenCalled();
            // TaskManager just logs and returns, doesn't update status
            expect(mockUpdateStatus).not.toHaveBeenCalled();
        });
    });

    describe("handleMediaBatchWebhook", () => {
        beforeEach(() => {
            TaskManager.handleDownloadWebhook = jest.fn().mockResolvedValue();
        });

        test("应当循环处理媒体组任务", async () => {
            const taskIds = ['123', '456', '789'];

            await TaskManager.handleMediaBatchWebhook('group1', taskIds);

            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledTimes(3);
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('123');
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('456');
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('789');
        });

        test("应当处理批量处理异常", async () => {
            TaskManager.handleDownloadWebhook.mockRejectedValue(new Error('Download failed'));

            // Should not throw, should handle gracefully
            await expect(TaskManager.handleMediaBatchWebhook('group1', ['123'])).resolves.toBeUndefined();
        });
    });
});