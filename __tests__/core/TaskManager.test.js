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

// Define safeEdit in the mock environment explicitly if needed, but the unmocked import should work if unmocked
// However, in ESM with jest.unstable_mockModule, we have to be careful.

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
});

// Provide safeEdit to the global scope of this module so TaskManager can find it if it was unmocked
global.safeEdit = mockSafeEdit;