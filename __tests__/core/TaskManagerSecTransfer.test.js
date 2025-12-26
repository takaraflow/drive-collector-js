import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// 1. Mock dependencies
jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: {
        downloadDir: "/tmp/downloads",
        remoteFolder: "remote_folder",
    },
}));

const mockClient = {
    downloadMedia: jest.fn(),
    editMessage: jest.fn().mockResolvedValue(),
    sendMessage: jest.fn().mockResolvedValue({ id: 123 })
};
jest.unstable_mockModule("../../src/services/telegram.js", () => ({
    client: mockClient,
}));

const mockCloudTool = {
    getRemoteFileInfo: jest.fn(),
    uploadBatch: jest.fn().mockResolvedValue({ success: true }),
};
jest.unstable_mockModule("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

const mockDatabaseService = {
    updateTaskStatus: jest.fn(),
    getTasksByMsgId: jest.fn().mockResolvedValue([]),
    createTask: jest.fn(),
    findCompletedTaskByFile: jest.fn(),
    getTaskById: jest.fn().mockResolvedValue(null),
    markTaskCancelled: jest.fn(),
    findPendingTasks: jest.fn().mockResolvedValue([]),
};
jest.unstable_mockModule("../../src/services/database.js", () => ({
    DatabaseService: mockDatabaseService,
}));

// Mock InstanceCoordinator
const mockInstanceCoordinator = {
    acquireTaskLock: jest.fn().mockResolvedValue(true),
    releaseTaskLock: jest.fn().mockResolvedValue(),
    hasLock: jest.fn().mockResolvedValue(true),
};
jest.unstable_mockModule("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: mockInstanceCoordinator,
}));

// Mock utils
jest.unstable_mockModule("../../src/utils/common.js", () => ({
    getMediaInfo: jest.fn((msg) => ({ name: "test_file.mp4", size: 10485760 })), // 10MB
    updateStatus: jest.fn(),
    escapeHTML: jest.fn(s => s),
    safeEdit: jest.fn(),
}));

jest.unstable_mockModule("../../src/utils/limiter.js", () => ({
    runBotTask: jest.fn(fn => fn()),
    runMtprotoTask: jest.fn(fn => fn()),
    runBotTaskWithRetry: jest.fn(fn => fn()),
    runMtprotoTaskWithRetry: jest.fn(fn => fn()),
    runMtprotoFileTaskWithRetry: jest.fn(fn => fn()),
    PRIORITY: { UI: 1 }
}));

jest.unstable_mockModule("../../src/locales/zh-CN.js", () => ({
    STRINGS: {
        task: {
            parse_failed: "parse failed",
            success_sec_transfer: "sec transfer success",
            downloaded_waiting_upload: "downloaded waiting",
            cancelled: "cancelled",
            error_prefix: "error: "
        }
    },
    format: jest.fn((s, args) => s)
}));

jest.unstable_mockModule("../../src/modules/AuthGuard.js", () => ({
    AuthGuard: { can: jest.fn().mockResolvedValue(true) }
}));

jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: { batch: jest.fn() }
}));

jest.unstable_mockModule("../../src/services/kv.js", () => ({
    kv: {}
}));

// Mock fs
const mockFs = {
    existsSync: jest.fn(),
    promises: {
        stat: jest.fn(),
        unlink: jest.fn().mockResolvedValue()
    },
    statSync: jest.fn(),
    unlinkSync: jest.fn()
};
jest.unstable_mockModule("fs", () => ({
    default: mockFs
}));

// Import TaskManager
const { TaskManager } = await import("../../src/core/TaskManager.js");

describe("TaskManager - Second Transfer (Sec-Transfer) Logic", () => {
    let task;

    beforeEach(() => {
        jest.clearAllMocks();
        TaskManager.activeWorkers.clear();
        TaskManager.waitingTasks = [];
        
        // Ensure queues are paused so tasks stay in queue for inspection
        if (TaskManager.uploadQueue) {
            TaskManager.uploadQueue.clear();
            TaskManager.uploadQueue.pause(); 
        }
        if (TaskManager.downloadQueue) {
            TaskManager.downloadQueue.clear();
        }

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
        
        await TaskManager.downloadWorker(task);

        // Assertions
        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalledWith("test_file.mp4", "user_1");
        expect(mockDatabaseService.updateTaskStatus).toHaveBeenCalledWith("task_1", "completed");
        expect(mockClient.downloadMedia).not.toHaveBeenCalled(); // Skipped download
        // Should NOT enqueue upload task
        expect(TaskManager.uploadQueue.size).toBe(0); 
        expect(TaskManager.activeWorkers.has("task_1")).toBe(false);
    });

    test("Scenario 2: Remote Miss, Local Cache Hit - Should skip download, queue upload", async () => {
        // Mock Remote File missing
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        // Mock Local File exists and size matches
        mockFs.promises.stat.mockResolvedValue({ size: 10485760 });
        
        await TaskManager.downloadWorker(task);

        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalled();
        expect(mockFs.promises.stat).toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled(); // Skipped download
        
        // Should update status to 'downloaded'
        expect(mockDatabaseService.updateTaskStatus).toHaveBeenCalledWith("task_1", "downloaded");
        
        // Should enqueue upload task (Queue is paused, so size should be 1)
        expect(TaskManager.uploadQueue.size).toBe(1);
    });

    test("Scenario 3: Full Flow (No Hits) - Should download then queue upload", async () => {
        // Mock Remote File missing
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        // Mock Local File missing
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        
        mockClient.downloadMedia.mockResolvedValue(); // Download success

        await TaskManager.downloadWorker(task);

        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalled();
        expect(mockFs.promises.stat).toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled(); // Performed download
        
        // Should update status to 'downloaded'
        expect(mockDatabaseService.updateTaskStatus).toHaveBeenCalledWith("task_1", "downloaded");
        
        // Should enqueue upload task
        expect(TaskManager.uploadQueue.size).toBe(1);
    });

    test("Scenario 4: Size Mismatch Tolerance - Remote Hit within tolerance", async () => {
        // 10MB file. Tolerance is 1MB.
        // Remote file is 10MB + 500KB (within 1MB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 512000 });
        
        await TaskManager.downloadWorker(task);

        expect(mockDatabaseService.updateTaskStatus).toHaveBeenCalledWith("task_1", "completed");
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
    });

    test("Scenario 5: Size Mismatch Tolerance - Remote Hit OUTSIDE tolerance", async () => {
        // 10MB file. Tolerance is 1MB.
        // Remote file is 10MB + 2MB (outside 1MB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 2097152 });
        // Local file missing
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();

        await TaskManager.downloadWorker(task);

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
        
        // Proxy uploadQueue.add to track when it's called
        const originalAdd = TaskManager.uploadQueue.add.bind(TaskManager.uploadQueue);
        jest.spyOn(TaskManager.uploadQueue, 'add').mockImplementation((fn) => {
            callOrder.push("enqueueUpload");
            return originalAdd(fn);
        });

        await TaskManager.downloadWorker(task);

        // Verification: releaseLock MUST happen before enqueueUpload
        expect(callOrder).toEqual(["releaseLock", "enqueueUpload"]);
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
        
        await TaskManager.downloadWorker(smallTask);
        
        expect(mockDatabaseService.updateTaskStatus).toHaveBeenCalledWith("task_small", "completed");
    });

    test("Scenario 8: Edge Case - Small File Mismatch", async () => {
        const { getMediaInfo } = await import("../../src/utils/common.js");
        getMediaInfo.mockReturnValueOnce({ name: "small_diff.jpg", size: 512000 }); // 500KB

        // Remote file: 500KB + 15KB (Mismatch > 10KB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "small_diff.jpg", Size: 512000 + 15360 });
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();

        await TaskManager.downloadWorker({ ...task, id: "task_small_diff" });
        
        expect(mockClient.downloadMedia).toHaveBeenCalled();
    });
});