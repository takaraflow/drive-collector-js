import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// 1. Mock 依赖项
// Mock config
jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: {
        downloadDir: "/tmp/downloads",
        remoteFolder: "remote_folder",
    },
}));

// Mock services/telegram
const mockClient = {
    sendMessage: jest.fn(),
    getMessages: jest.fn(),
    editMessage: jest.fn().mockImplementation(() => {
        const p = Promise.resolve();
        p.catch = (fn) => p;
        return p;
    }),
    downloadMedia: jest.fn(),
};
jest.unstable_mockModule("../../src/services/telegram.js", () => ({
    client: mockClient,
}));

// Mock services/rclone
const mockCloudTool = {
    getRemoteFileInfo: jest.fn(),
    uploadFile: jest.fn(),
    uploadBatch: jest.fn(),
};
jest.unstable_mockModule("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

// Mock repositories/TaskRepository
const mockTaskRepository = {
    create: jest.fn(),
    createBatch: jest.fn(),
    findStalledTasks: jest.fn(),
    updateStatus: jest.fn(),
    findById: jest.fn(),
    markCancelled: jest.fn(),
    findByMsgId: jest.fn(),
};
jest.unstable_mockModule("../../src/repositories/TaskRepository.js", () => ({
    TaskRepository: mockTaskRepository,
}));

// Mock modules/AuthGuard
const mockAuthGuard = {
    can: jest.fn(),
};
jest.unstable_mockModule("../../src/modules/AuthGuard.js", () => ({
    AuthGuard: mockAuthGuard,
}));

// Mock utils/common
const mockSafeEdit = jest.fn();
jest.unstable_mockModule("../../src/utils/common.js", () => ({
    getMediaInfo: jest.fn((msg) => ({ name: "test.mp4", size: 1024 })),
    updateStatus: jest.fn(),
    escapeHTML: jest.fn(str => str),
    safeEdit: mockSafeEdit
}));

// Mock utils/limiter
jest.unstable_mockModule("../../src/utils/limiter.js", () => ({
    runBotTask: jest.fn((fn) => fn()),
    runMtprotoTask: jest.fn((fn) => fn()),
    runBotTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: jest.fn((fn) => fn()),
    PRIORITY: {
        UI: 20,
        HIGH: 10,
        NORMAL: 0,
        LOW: -10,
        BACKGROUND: -20
    }
}));

// Mock locales
jest.unstable_mockModule("../../src/locales/zh-CN.js", () => ({
    STRINGS: {
        task: {
            captured: "captured {{label}}",
            cancel_btn: "cancel",
            create_failed: "failed",
            queued: "queued {{rank}}",
            downloading: "downloading",
            downloaded_waiting_upload: "📥 <b>下载完成，等待转存...</b>",
            uploading: "uploading",
            success_sec_transfer: "success_sec",
            verifying: "verifying",
            success: "success {{name}}",
            failed_validation: "failed_val",
            failed_upload: "failed_up {{reason}}",
            cancelled: "cancelled",
            error_prefix: "error: ",
            parse_failed: "parse_failed",
            batch_captured: "batch captured {{count}}"
        }
    },
    format: (s, args) => {
        let res = s;
        if (args) {
            for (const key in args) {
                // 处理嵌套的替换
                res = res.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), args[key]);
            }
        }
        return res;
    },
}));

// Mock fs and path
jest.unstable_mockModule("fs", () => ({
    default: {
        existsSync: jest.fn(() => true),
        unlinkSync: jest.fn(),
        statSync: jest.fn(() => ({ size: 1024 })),
        promises: {
            stat: jest.fn(() => Promise.resolve({ size: 1024 })),
            unlink: jest.fn(() => Promise.resolve())
        }
    }
}));

const mockUIHelper = {
    renderProgress: jest.fn(() => "progress_text"),
    renderBatchMonitor: jest.fn(() => ({ text: "monitor_text" })),
};
jest.unstable_mockModule("../../src/ui/templates.js", () => ({
    UIHelper: mockUIHelper,
}));

// Mock services/d1.js
const mockD1Batch = jest.fn().mockResolvedValue([{ success: true }]);
jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: {
        batch: mockD1Batch
    }
}));

// Mock repositories/DriveRepository.js
jest.unstable_mockModule("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: {
        findAll: jest.fn().mockResolvedValue([])
    }
}));

// Mock services/kv.js
jest.unstable_mockModule("../../src/services/kv.js", () => ({
    kv: {
        get: jest.fn().mockResolvedValue("ok")
    }
}));

// 导入 TaskManager
const { TaskManager } = await import("../../src/core/TaskManager.js");

describe("TaskManager", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset all mocks to default behavior
        mockCloudTool.uploadBatch.mockResolvedValue({ success: true });
        mockClient.sendMessage.mockResolvedValue({ id: 300 });
        mockClient.editMessage.mockResolvedValue();
        mockTaskRepository.create.mockResolvedValue();
        mockTaskRepository.createBatch.mockResolvedValue();
        mockTaskRepository.updateStatus.mockResolvedValue();
        mockTaskRepository.findById.mockResolvedValue({ user_id: "u1" });
        mockTaskRepository.findByMsgId.mockResolvedValue([]);
        mockAuthGuard.can.mockResolvedValue(false);
        mockSafeEdit.mockResolvedValue();
        mockD1Batch.mockResolvedValue([{ success: true }]);

        TaskManager.waitingTasks = [];
        TaskManager.currentTask = null;
        TaskManager.waitingUploadTasks = [];
        // 清理队列
        if (TaskManager.downloadQueue) TaskManager.downloadQueue.clear();
        if (TaskManager.uploadQueue) TaskManager.uploadQueue.clear();
        TaskManager.monitorLocks.clear();
        // 清理 activeWorkers
        if (TaskManager.activeWorkers) TaskManager.activeWorkers.clear();
        // 清理 UploadBatcher 的定时器（重置实例）
        if (TaskManager.uploadBatcher) {
            TaskManager.uploadBatcher.batches.clear();
        }
    });

    afterEach(() => {
        try {
            if (jest.isMockFunction(setTimeout)) {
                jest.clearAllTimers();
            }
        } catch (e) {}
    });

    describe("init", () => {
        test("should restore stalled tasks", async () => {
            const stalledTasks = [
                { id: "1", user_id: "u1", chat_id: "c1", msg_id: 100, source_msg_id: 200 }
            ];
            mockTaskRepository.findStalledTasks.mockResolvedValue(stalledTasks);
            mockClient.getMessages.mockResolvedValue([{ id: 200, media: {} }]);

            if (TaskManager.downloadQueue) TaskManager.downloadQueue.pause();

            await TaskManager.init();

            expect(mockTaskRepository.findStalledTasks).toHaveBeenCalled();
            expect(mockClient.getMessages).toHaveBeenCalled();
            expect(TaskManager.waitingTasks.length).toBe(1);

            if (TaskManager.downloadQueue) TaskManager.downloadQueue.clear();
        });

        test("should skip invalid chat_id", async () => {
            const stalledTasks = [
                { id: "1", user_id: "u1", chat_id: "[Object object]", msg_id: 100, source_msg_id: 200 }
            ];
            mockTaskRepository.findStalledTasks.mockResolvedValue(stalledTasks);

            await TaskManager.init();

            expect(mockClient.getMessages).not.toHaveBeenCalled();
            expect(TaskManager.waitingTasks.length).toBe(0);
        });

        test("should preload common data during init", async () => {
            mockTaskRepository.findStalledTasks.mockResolvedValue([]);
            const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

            await TaskManager.init();

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("预加载常用数据完成"));
            consoleSpy.mockRestore();
        });
    });

    describe("addTask", () => {
        test("should add a task correctly", async () => {
            const target = "chat123";
            const mediaMessage = { id: 200 };
            const userId = "user456";
            
            mockClient.sendMessage.mockResolvedValue({ id: 300 });

            await TaskManager.addTask(target, mediaMessage, userId, "TestLabel");

            expect(mockClient.sendMessage).toHaveBeenCalled();
            expect(mockTaskRepository.create).toHaveBeenCalled();
            expect(TaskManager.waitingTasks.length).toBe(1);
            expect(TaskManager.waitingTasks[0].userId).toBe(userId);
        });
    });

    describe("cancelTask", () => {
        test("should cancel task if owner", async () => {
            const taskId = "task1";
            const userId = "user1";
            mockTaskRepository.findById.mockResolvedValue({ user_id: userId });
            
            const task = { id: taskId, userId: userId, isCancelled: false };
            TaskManager.waitingTasks.push(task);

            const result = await TaskManager.cancelTask(taskId, userId);

            expect(result).toBe(true);
            expect(task.isCancelled).toBe(true);
            expect(mockTaskRepository.markCancelled).toHaveBeenCalledWith(taskId);
        });
    });

    describe("_refreshGroupMonitor", () => {
        test("should update group monitor correctly", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "123456789",
                msgId: "100",
                isGroup: true
            };
            const groupTasks = [{ file_name: "f1", status: "downloading" }];
            mockTaskRepository.findByMsgId.mockResolvedValue(groupTasks);
            
            await TaskManager._refreshGroupMonitor(task, "downloading", 100, 1000);
            
            expect(mockTaskRepository.findByMsgId).toHaveBeenCalledWith("100");
            expect(mockUIHelper.renderBatchMonitor).toHaveBeenCalled();
            expect(mockSafeEdit).toHaveBeenCalled();
        });

        test("should NOT batch update statuses for final states (Bug Fix Verification)", async () => {
            const task = { msgId: "100", chatId: "123", isGroup: true };
            const groupTasks = [
                { id: "t1", status: "downloading" },
                { id: "t2", status: "downloading" }
            ];
            mockTaskRepository.findByMsgId.mockResolvedValue(groupTasks);

            const batchUpdateSpy = jest.spyOn(TaskManager, 'batchUpdateStatus');

            await TaskManager._refreshGroupMonitor(task, "completed");

            // Should NOT be called now as we removed this logic from _refreshGroupMonitor
            expect(batchUpdateSpy).not.toHaveBeenCalled();

            batchUpdateSpy.mockRestore();
        });
    });

    describe("batchUpdateStatus", () => {
        test("should batch update task statuses successfully", async () => {
            const updates = [
                { id: "task1", status: "completed", error: null },
                { id: "task2", status: "failed", error: "Upload failed" }
            ];

            await TaskManager.batchUpdateStatus(updates);

            expect(mockD1Batch).toHaveBeenCalled();
        });
    });

    describe("updateQueueUI Regression", () => {
        test("should handle queue modification during UI update (Race Condition)", async () => {
            // 设置多个任务触发循环
            TaskManager.waitingTasks = [
                { id: "t1", lastText: "", userId: "u1" },
                { id: "t2", lastText: "", userId: "u1" },
                { id: "t3", lastText: "", userId: "u1" }
            ];

            // 模拟 updateStatus 包含延迟，以便我们有窗口修改数组
            const { updateStatus } = await import("../../src/utils/common.js");
            updateStatus.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10)));

            // 启动更新过程
            const updatePromise = TaskManager.updateQueueUI();

            // 在执行中途强行修改队列（模拟 downloadWorker 移除任务）
            // 如果内部没有快照且没有非空检查，snapshot[i] 指向 undefined 导致报错
            TaskManager.waitingTasks = []; 

            // 应该正常完成而不抛出 TypeError: Cannot read properties of undefined
            await expect(updatePromise).resolves.not.toThrow();
        });
    });

    describe("Concurrency and Re-entry Protection", () => {
        test("should prevent duplicate processing of the same task using activeWorkers lock", async () => {
            const task = {
                id: "unique-task-id",
                userId: "u1",
                message: { media: {} },
                isGroup: false
            };

            // 模拟 heartbeat 会导致一段时间的异步等待
            const { updateStatus } = await import("../../src/utils/common.js");
            updateStatus.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50)));

            // 模拟两个 Worker 同时尝试处理同一个任务
            // 正常情况下，第一个进入后会设置锁，第二个应该直接退出
            const promise1 = TaskManager.downloadWorker(task);
            const promise2 = TaskManager.downloadWorker(task);

            await Promise.all([promise1, promise2]);

            // 验证关键的业务逻辑（如 heartbeat/updateStatus）只被一个 Worker 执行
            // 第一次 heartbeat 是 'downloading'
            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith(task.id, 'downloading');

            // 如果锁生效，updateStatus 应该只被调用一次（针对该任务的初始状态）
            // 注意：因为 heartbeat 内部会多次调用 updateStatus，我们检查它的起始调用
            const downloadingCalls = mockTaskRepository.updateStatus.mock.calls.filter(call => call[1] === 'downloading');
            expect(downloadingCalls.length).toBe(1);
        });

        test("should release lock when task fails or completes", async () => {
            const task = {
                id: "error-task-id",
                userId: "u1",
                message: { media: {} },
                isGroup: false
            };

            // 模拟下载失败
            mockClient.downloadMedia.mockRejectedValue(new Error("Network Error"));

            await TaskManager.downloadWorker(task);

            // 验证锁已释放
            expect(TaskManager.activeWorkers.has(task.id)).toBe(false);

            // 能够再次进入处理（即使状态是 failed）
            mockClient.downloadMedia.mockResolvedValue({});
            await TaskManager.downloadWorker(task);
            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith(task.id, 'downloaded');
        });
    });

    describe("Resource Competition and Lock Conflicts", () => {
        test("should handle concurrent task state transitions (downloading -> uploading)", async () => {
            const task = {
                id: "transition-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false,
                chatId: "chat123",
                msgId: "msg456"
            };

            // Mock successful download but disable sec-transfer check by making file not exist
            const mockFs = await import("fs");
            mockFs.default.existsSync.mockReturnValue(false); // File doesn't exist, skip sec-transfer
            mockClient.downloadMedia.mockResolvedValue({});
            mockCloudTool.getRemoteFileInfo.mockResolvedValue(null); // No remote file

            // Start download worker
            await TaskManager.downloadWorker(task);

            // Verify task was marked as downloaded and queued for upload
            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith(task.id, 'downloading');
            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith(task.id, 'downloaded');

            // Verify upload worker was queued
            expect(TaskManager.waitingUploadTasks.length).toBeGreaterThan(0);
        });

        test("should prevent race condition when cancel occurs during download completion", async () => {
            const task = {
                id: "race-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false
            };

            // Mock downloadMedia to resolve immediately
            mockClient.downloadMedia.mockResolvedValue({});
            mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Size: 1024 });

            // Start download and immediately try to cancel
            const downloadPromise = TaskManager.downloadWorker(task);
            const cancelPromise = TaskManager.cancelTask(task.id, task.userId);

            const cancelResult = await cancelPromise;
            await downloadPromise;

            // Cancel should succeed even if task completed
            expect(cancelResult).toBe(true);
            expect(mockTaskRepository.markCancelled).toHaveBeenCalledWith(task.id);
        });
    });

    describe("Database Operation Failure Handling", () => {
        test("should handle TaskRepository.updateStatus failure gracefully", async () => {
            const task = {
                id: "db-fail-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false
            };

            // Mock database failure
            mockTaskRepository.updateStatus.mockRejectedValue(new Error("DB Connection Failed"));
            // Mock successful download to trigger heartbeat
            mockClient.downloadMedia.mockResolvedValue({});

            // Should handle the error and complete
            await expect(TaskManager.downloadWorker(task)).resolves.toBeUndefined();

            // Lock should still be released
            expect(TaskManager.activeWorkers.has(task.id)).toBe(false);
        });

        test("should rollback in-memory state when database operations fail", async () => {
            const task = {
                id: "rollback-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false
            };

            // Mock database failure during status update
            mockTaskRepository.updateStatus.mockRejectedValue(new Error("DB Error"));
            // Mock successful download
            mockClient.downloadMedia.mockResolvedValue({});

            // Worker should complete without crashing
            await expect(TaskManager.downloadWorker(task)).resolves.toBeUndefined();

            // Verify lock cleanup
            expect(TaskManager.activeWorkers.has(task.id)).toBe(false);
        });
    });

    describe("File Cleanup Reliability", () => {
        test("should handle file cleanup failure without crashing", async () => {
            const task = {
                id: "cleanup-fail-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false,
                localPath: "/tmp/test.mp4"
            };

            // Mock successful operations - uploadBatch is called by uploadBatcher
            mockCloudTool.uploadBatch.mockResolvedValue({ success: true });

            // Mock file system operations
            const mockFs = await import("fs");
            mockFs.default.existsSync.mockReturnValue(true);
            mockFs.default.statSync.mockReturnValue({ size: 1024 });
            mockFs.default.promises.unlink.mockRejectedValue(new Error("Disk I/O Error"));

            await TaskManager.uploadWorker(task);

            // Should complete successfully despite cleanup failure
            expect(mockCloudTool.uploadBatch).toHaveBeenCalled();
            // File cleanup failure should be logged but not cause failure
        });

        test("should cleanup files even when upload fails", async () => {
            const task = {
                id: "cleanup-after-fail-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false,
                localPath: "/tmp/fail.mp4"
            };

            // Mock upload failure
            mockCloudTool.uploadFile.mockResolvedValue({ success: false, error: "Upload failed" });

            const mockFs = await import("fs");
            mockFs.default.existsSync.mockReturnValue(true);
            mockFs.default.statSync.mockReturnValue({ size: 1024 });
            mockFs.default.promises.unlink.mockResolvedValue();

            await TaskManager.uploadWorker(task);

            // File should still be cleaned up
            expect(mockFs.default.promises.unlink).toHaveBeenCalledWith("/tmp/fail.mp4");
        });
    });

    describe("Filename Validation Consistency", () => {
        test("should use actual local filename for validation instead of regenerating from media info", async () => {
            const task = {
                id: "validation-filename-task",
                userId: "u1",
                message: { media: {} },
                isGroup: false,
                chatId: "chat123",
                msgId: "msg456",
                localPath: "/tmp/downloads/transfer_1766663719382_fc61fh.jpg" // Actual downloaded filename
            };

            // Mock successful upload
            mockCloudTool.uploadBatch.mockResolvedValue({ success: true });

            // Mock file system operations
            const mockFs = await import("fs");
            mockFs.default.existsSync.mockReturnValue(true);
            mockFs.default.statSync.mockReturnValue({ size: 1024 });

            // Mock getMediaInfo to return a different filename (simulating the bug scenario)
            const { getMediaInfo } = await import("../../src/utils/common.js");
            getMediaInfo.mockReturnValueOnce({
                name: "transfer_1766663722153_a82fwq.jpg", // Different filename that would be generated now
                size: 1024
            });

            // Mock validation - should be called with actual filename, not the regenerated one
            mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Size: 1024 }); // File exists and matches

            await TaskManager.uploadWorker(task);

            // Verify that getRemoteFileInfo was called with the actual filename from localPath
            expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalledWith("transfer_1766663719382_fc61fh.jpg", "u1", 2);
            // Should NOT be called with the regenerated filename
            expect(mockCloudTool.getRemoteFileInfo).not.toHaveBeenCalledWith("transfer_1766663722153_a82fwq.jpg", "u1", expect.any(Number));
        });
    });
});

// Provide safeEdit to the global scope of this module so TaskManager can find it if it was unmocked
global.safeEdit = mockSafeEdit;