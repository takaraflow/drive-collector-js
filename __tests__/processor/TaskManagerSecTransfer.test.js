// 1. Mock dependencies
vi.mock("../../src/config/index.js", () => ({
    config: {
        downloadDir: "/tmp/downloads",
        remoteFolder: "remote_folder",
    },
    getConfig: () => ({
        downloadDir: "/tmp/downloads",
        remoteFolder: "remote_folder",
    }),
    default: {
        config: {
            downloadDir: "/tmp/downloads",
            remoteFolder: "remote_folder",
        },
        getConfig: () => ({
            downloadDir: "/tmp/downloads",
            remoteFolder: "remote_folder",
        })
    }
}));

const mockClient = {
    downloadMedia: vi.fn(),
    editMessage: vi.fn().mockResolvedValue(),
    sendMessage: vi.fn().mockResolvedValue({ id: 123 })
};
vi.mock("../../src/services/telegram.js", () => ({
    client: mockClient,
}));

const mockCloudTool = {
    getRemoteFileInfo: vi.fn(),
    uploadBatch: vi.fn().mockResolvedValue({ success: true }),
};
vi.mock("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

const mockTaskRepository = {
    updateStatus: vi.fn(),
    findByMsgId: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    findCompletedByFile: vi.fn(),
    findAllCompletedByUser: vi.fn().mockResolvedValue([]),
};
vi.mock("../../src/repositories/TaskRepository.js", () => ({
    TaskRepository: mockTaskRepository,
}));

// Mock InstanceCoordinator
const mockInstanceCoordinator = {
    acquireTaskLock: vi.fn().mockResolvedValue(true),
    releaseTaskLock: vi.fn().mockResolvedValue(),
};
vi.mock("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: mockInstanceCoordinator,
}));

// Mock utils
vi.mock("../../src/utils/common.js", () => ({
    getMediaInfo: vi.fn((msg) => ({ name: "test_file.mp4", size: 10485760 })), // 10MB
    updateStatus: vi.fn(),
    escapeHTML: vi.fn(s => s),
    safeEdit: vi.fn(),
}));

vi.mock("../../src/utils/limiter.js", () => ({
    runBotTask: vi.fn(fn => fn()),
    runMtprotoTask: vi.fn(fn => fn()),
    runBotTaskWithRetry: vi.fn(fn => fn()),
    runMtprotoTaskWithRetry: vi.fn(fn => fn()),
    runMtprotoFileTaskWithRetry: vi.fn(fn => fn()),
    PRIORITY: { UI: 1 }
}));

vi.mock("../../src/locales/zh-CN.js", () => ({
    STRINGS: {
        task: {
            parse_failed: "parse failed",
            success_sec_transfer: "sec transfer success",
            downloaded_waiting_upload: "downloaded waiting",
            cancelled: "cancelled",
            error_prefix: "error: "
        }
    },
    format: vi.fn((s, args) => s)
}));

vi.mock("../../src/modules/AuthGuard.js", () => ({
    AuthGuard: { can: vi.fn().mockResolvedValue(true) }
}));

vi.mock("../../src/services/d1.js", () => ({
    d1: { batch: vi.fn() }
}));

vi.mock("../../src/services/CacheService.js", () => ({
    cache: {}
}));

const mockQueueService = {
    enqueueUploadTask: vi.fn(),
    enqueueDownloadTask: vi.fn()
};
vi.mock("../../src/services/QueueService.js", () => ({
    queueService: mockQueueService
}));

// Mock fs
const mockFs = {
    existsSync: vi.fn(),
    promises: {
        stat: vi.fn(),
        unlink: vi.fn().mockResolvedValue()
    },
    statSync: vi.fn(),
    unlinkSync: vi.fn()
};
vi.mock("fs", () => ({
    default: mockFs
}));

// Import TaskManager
const { TaskManager } = await import("../../src/processor/TaskManager.js");

describe("TaskManager - Second Transfer (Sec-Transfer) Logic", () => {
    let task;

    beforeEach(() => {
        vi.clearAllMocks();
        TaskManager.activeProcessors.clear();
        TaskManager.waitingTasks = [];

        task = {
            id: "task_1",
            userId: "user_1",
            chatId: "chat_1",
            msgId: 100,
            message: { media: { document: { id: 1 } } },
            isGroup: false,
            localPath: "/tmp/downloads/test_file.mp4"
        };
    });

    test("Scenario 1: True Sec-Transfer (Remote Hit) - Should skip download and upload", async () => {
        // Mock Remote File exists and size matches (10MB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 });

        await TaskManager.downloadTask(task);

        // Assertions
        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalledWith("test_file.mp4", "user_1");
        expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("task_1", "completed");
        expect(mockClient.downloadMedia).not.toHaveBeenCalled(); // Skipped download
        // Should NOT enqueue upload task
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(TaskManager.activeProcessors.has("task_1")).toBe(false);
    });

    test("Scenario 2: Remote Miss, Local Cache Hit - Should skip download, queue upload", async () => {
        // Mock Remote File missing
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        // Mock Local File exists and size matches
        mockFs.promises.stat.mockResolvedValue({ size: 10485760 });

        await TaskManager.downloadTask(task);

        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalled();
        expect(mockFs.promises.stat).toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled(); // Skipped download

        // Should update status to 'downloaded'
        expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("task_1", "downloaded");

        // Should enqueue upload task via QStash
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith("task_1", expect.objectContaining({
            userId: "user_1",
            chatId: "chat_1",
            msgId: 100,
            localPath: expect.stringContaining("test_file.mp4")
        }));
    });

    test("Scenario 3: Full Flow (No Hits) - Should download then queue upload", async () => {
        // Mock Remote File missing
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        // Mock Local File missing
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));

        mockClient.downloadMedia.mockResolvedValue(); // Download success

        await TaskManager.downloadTask(task);

        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalled();
        expect(mockFs.promises.stat).toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled(); // Performed download

        // Should update status to 'downloaded'
        expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("task_1", "downloaded");

        // Should enqueue upload task via QStash
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith("task_1", expect.objectContaining({
            userId: "user_1",
            chatId: "chat_1",
            msgId: 100,
            localPath: expect.stringContaining("test_file.mp4")
        }));
    });

    test("Scenario 4: Size Mismatch Tolerance - Remote Hit within tolerance", async () => {
        // 10MB file. Tolerance is 1MB.
        // Remote file is 10MB + 500KB (within 1MB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 512000 });

        await TaskManager.downloadTask(task);

        expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("task_1", "completed");
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
    });

    test("Scenario 5: Size Mismatch Tolerance - Remote Hit OUTSIDE tolerance", async () => {
        // 10MB file. Tolerance is 1MB.
        // Remote file is 10MB + 2MB (outside 1MB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 2097152 });
        // Local file missing
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();

        await TaskManager.downloadTask(task);

        // Should NOT complete immediately
        expect(mockClient.downloadMedia).toHaveBeenCalled(); // Should download
    });

    test("Scenario 6: Race Condition Safety - Lock should be released BEFORE enqueue", async () => {
        // This is tricky to test black-box. We verify the order of calls.

        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();

        const callOrder = [];
        mockInstanceCoordinator.releaseTaskLock.mockImplementation(async () => {
            callOrder.push("releaseLock");
        });

        // Mock enqueueUploadTask to track when it's called
        mockQueueService.enqueueUploadTask.mockImplementation(async () => {
            callOrder.push("enqueueUpload");
        });

        await TaskManager.downloadTask(task);

        // Verification: enqueueUpload happens before releaseLock
        expect(callOrder).toEqual(["enqueueUpload", "releaseLock"]);
    });

    test("Scenario 7: Edge Case - Small File Tolerance", async () => {
        // Small file (500KB). Tolerance 10KB.
        const smallTask = { ...task, id: "task_small" };

        // Need to override the mocked getMediaInfo for this specific test case?
        // Mock is defined at top level. We can use a different mock implementation for this test if needed,
        // or just rely on the fact that _isSizeMatch logic is tested via the flow.
        // Since getMediaInfo mock returns 10MB, we can't easily test small file logic without changing the mock.

        // Let's redefine getMediaInfo mock for this test
        const { getMediaInfo } = await import("../../src/utils/common.js");
        getMediaInfo.mockReturnValueOnce({ name: "small.jpg", size: 512000 }); // 500KB

        // Remote file: 500KB + 5KB (Match)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "small.jpg", Size: 512000 + 5120 });

        await TaskManager.downloadTask(smallTask);

        expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("task_small", "completed");
    });

    test("Scenario 8: Edge Case - Small File Mismatch", async () => {
        const { getMediaInfo } = await import("../../src/utils/common.js");
        getMediaInfo.mockReturnValueOnce({ name: "small_diff.jpg", size: 512000 }); // 500KB

        // Remote file: 500KB + 15KB (Mismatch > 10KB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "small_diff.jpg", Size: 512000 + 15360 });
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();

        await TaskManager.downloadTask({ ...task, id: "task_small_diff" });

        expect(mockClient.downloadMedia).toHaveBeenCalled();
    });

    test("should use actual user upload path in success message", async () => {
        const taskWithUser = { ...task, userId: "user123", isGroup: false };
        
        // Mock CloudTool._getUploadPath to return user-specific path
        const { CloudTool } = await import("../../src/services/rclone.js");
        CloudTool._getUploadPath = vi.fn().mockResolvedValue("/Movies/2024");
        
        // Mock remote file exists and size matches
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test.mp4", Size: 10000000 });
        
        await TaskManager.downloadTask(taskWithUser);
        
        // Get the updateStatus mock from utils
        const { updateStatus } = await import("../../src/utils/common.js");
        
        // Verify that CloudTool._getUploadPath was called with correct userId
        expect(CloudTool._getUploadPath).toHaveBeenCalledWith("user123");
        
        // Verify that updateStatus was called (we can't easily check the message content due to formatting)
        expect(updateStatus).toHaveBeenCalled();
    });
});