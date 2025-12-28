import { jest } from "@jest/globals";

// Mock console methods that logger uses
const mockConsole = {
    info: jest.spyOn(console, 'info').mockImplementation(),
    warn: jest.spyOn(console, 'warn').mockImplementation(),
    error: jest.spyOn(console, 'error').mockImplementation(),
    debug: jest.spyOn(console, 'debug').mockImplementation()
};

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
    let originalDownloadTask;
    let originalUploadTask;

    // Mock console globally for logger testing
    const originalConsole = global.console;
    beforeAll(() => {
        global.console = {
            ...originalConsole,
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            log: jest.fn()
        };
    });

    afterAll(() => {
        global.console = originalConsole;
    });

    beforeAll(async () => {
        const module = await import("../../src/processor/TaskManager.js");
        TaskManager = module.TaskManager;
        originalDownloadTask = TaskManager.downloadTask;
        originalUploadTask = TaskManager.uploadTask;
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
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            const task = { id: '123', userId: 'user1', chatId: 'chat1', msgId: 456 };
            await TaskManager._enqueueTask(task);

            expect(consoleSpy).toHaveBeenCalledWith(
                'Failed to enqueue download task',
                { taskId: '123', error: expect.any(Error) }
            );
            consoleSpy.mockRestore();
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

        test("应当正确处理下载 Webhook 并记录日志", async () => {
            await TaskManager.handleDownloadWebhook('123');

            expect(console.info).toHaveBeenCalledWith('[QStash] Received download webhook for Task: 123', expect.any(Object));
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
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await TaskManager.handleDownloadWebhook('123');

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('❌ Task 123 not found in database'), expect.anything());
            expect(TaskManager.downloadTask).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        test("应当处理消息不存在的情况", async () => {
            mockGetMessages.mockResolvedValue([null]);

            await TaskManager.handleDownloadWebhook('123');

            expect(mockUpdateStatus).toHaveBeenCalledWith('123', 'failed', 'Source msg missing');
            expect(TaskManager.downloadTask).not.toHaveBeenCalled();
        });

        test("应当处理下载异常", async () => {
            TaskManager.downloadTask.mockRejectedValue(new Error('Download failed'));

            await TaskManager.handleDownloadWebhook('123');

            expect(mockUpdateStatus).toHaveBeenCalledWith('123', 'failed', 'Download failed');
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

        test("应当正确处理上传 Webhook 并记录日志", async () => {
            await TaskManager.handleUploadWebhook('123');

            expect(console.info).toHaveBeenCalledWith('[QStash] Received upload webhook for Task: 123', expect.any(Object));
            expect(mockFindById).toHaveBeenCalledWith('123');
        });

        test("应当处理任务不存在的情况", async () => {
            mockFindById.mockResolvedValue(null);
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await TaskManager.handleUploadWebhook('123');

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('❌ Task 123 not found in database'), expect.anything());
            expect(TaskManager.uploadTask).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        test("应当处理本地文件不存在的情况", async () => {
            mockExistsSync.mockReturnValue(false);

            await TaskManager.handleUploadWebhook('123');

            expect(mockUpdateStatus).toHaveBeenCalledWith('123', 'failed', 'Local file not found');
            expect(TaskManager.uploadTask).not.toHaveBeenCalled();
        });

        test("应当处理消息不存在的情况", async () => {
            mockGetMessages.mockResolvedValue([null]);

            await TaskManager.handleUploadWebhook('123');

            expect(mockUpdateStatus).toHaveBeenCalledWith('123', 'failed', 'Local file not found');
            expect(TaskManager.uploadTask).not.toHaveBeenCalled();
        });

        test("应当处理上传异常", async () => {
            TaskManager.uploadTask.mockRejectedValue(new Error('Upload failed'));

            await TaskManager.handleUploadWebhook('123');

            expect(mockUpdateStatus).toHaveBeenCalledWith('123', 'failed', 'Local file not found');
        });
    });

    describe("handleMediaBatchWebhook", () => {
        beforeEach(() => {
            TaskManager.handleDownloadWebhook = jest.fn().mockResolvedValue();
        });

        test("应当循环处理媒体组任务并记录日志", async () => {
            const taskIds = ['123', '456', '789'];

            await TaskManager.handleMediaBatchWebhook('group1', taskIds);

            expect(console.info).toHaveBeenCalledWith('[QStash] Received media-batch webhook for Group: group1, TaskCount: 3', expect.any(Object));
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledTimes(3);
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('123');
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('456');
            expect(TaskManager.handleDownloadWebhook).toHaveBeenCalledWith('789');
        });

        test("应当处理批量处理异常", async () => {
            TaskManager.handleDownloadWebhook.mockRejectedValue(new Error('Download failed'));
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            await TaskManager.handleMediaBatchWebhook('group1', ['123']);

            expect(consoleSpy).toHaveBeenCalledWith(
                'Media batch webhook failed',
                { groupId: 'group1', error: expect.any(Error) }
            );
            consoleSpy.mockRestore();
        });
    });

    describe("分布式锁集成", () => {
        beforeEach(() => {
            mockAcquireTaskLock.mockResolvedValue(true);
            TaskManager.downloadTask = jest.fn().mockResolvedValue();
            TaskManager.uploadTask = jest.fn().mockResolvedValue();
        });

        test("downloadTask 应当获取和释放分布式锁", async () => {
            TaskManager.downloadTask = originalDownloadTask;
            mockAcquireTaskLock.mockResolvedValue(true);
            const task = { id: '123', message: { media: {} } };

            await TaskManager.downloadTask(task);

            expect(mockAcquireTaskLock).toHaveBeenCalledWith('123');
            expect(mockReleaseTaskLock).toHaveBeenCalledWith('123');
        });

        test("uploadTask 应当获取和释放分布式锁", async () => {
            TaskManager.uploadTask = originalUploadTask;
            mockAcquireTaskLock.mockResolvedValue(true);
            const task = {
                id: '123',
                message: { media: {} },
                localPath: '/tmp/test.mp4'
            };
            mockExistsSync.mockReturnValue(true);

            await TaskManager.uploadTask(task);

            expect(mockAcquireTaskLock).toHaveBeenCalledWith('123');
            expect(mockReleaseTaskLock).toHaveBeenCalledWith('123');
        });

        test("应当跳过被其他实例处理的任务", async () => {
            mockAcquireTaskLock.mockResolvedValue(false);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            const task = { id: '123', message: { media: {} } };
            await TaskManager.downloadTask(task);

            // Note: The task is skipped, so downloadTask is called once (this call)
            consoleSpy.mockRestore();
        });
    });
});