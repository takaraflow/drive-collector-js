import { jest, describe, test, expect, beforeEach } from "@jest/globals";

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
jest.unstable_mockModule("../../src/utils/common.js", () => ({
    getMediaInfo: jest.fn((msg) => ({ name: "test.mp4", size: 1024 })),
    updateStatus: jest.fn(),
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
                res = res.replace(`{{${key}}}`, args[key]);
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
    }
}));

const mockUIHelper = {
    renderProgress: jest.fn(() => "progress_text"),
    renderBatchMonitor: jest.fn(() => ({ text: "monitor_text" })),
};
jest.unstable_mockModule("../../src/ui/templates.js", () => ({
    UIHelper: mockUIHelper,
}));

// 导入 TaskManager
const { TaskManager } = await import("../../src/core/TaskManager.js");
const { updateStatus } = await import("../../src/utils/common.js");

describe("TaskManager", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        TaskManager.waitingTasks = [];
        TaskManager.currentTask = null;
        // 清理队列
        TaskManager.queue.clear();
        TaskManager.monitorLocks.clear();
    });

    describe("init", () => {
        test("should restore stalled tasks", async () => {
            const stalledTasks = [
                { id: "1", user_id: "u1", chat_id: "c1", msg_id: 100, source_msg_id: 200 }
            ];
            mockTaskRepository.findStalledTasks.mockResolvedValue(stalledTasks);
            mockClient.getMessages.mockResolvedValue([{ id: 200, media: {} }]);

            // 暂停队列以防止任务被 worker 立即取出处理（导致从 waitingTasks 中移除）
            TaskManager.queue.pause();

            await TaskManager.init();

            expect(mockTaskRepository.findStalledTasks).toHaveBeenCalled();
            expect(mockClient.getMessages).toHaveBeenCalled();
            expect(TaskManager.waitingTasks.length).toBe(1);
            
            // 确保清理，避免 open handles
            TaskManager.queue.clear();
        });

        test("should handle init error", async () => {
            mockTaskRepository.findStalledTasks.mockRejectedValue(new Error("Init DB Error"));
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

            await TaskManager.init();

            expect(consoleSpy).toHaveBeenCalledWith("TaskManager.init critical error:", expect.any(Error));
            consoleSpy.mockRestore();
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
    });

    describe("addTask", () => {
        beforeEach(() => {
            TaskManager.queue.pause(); // 默认暂停，方便检查 waitingTasks
        });

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

        test("should handle creation failure", async () => {
            const target = "chat123";
            const mediaMessage = { id: 200 };
            const userId = "user456";
            
            mockClient.sendMessage.mockResolvedValue({ id: 300 });
            mockTaskRepository.create.mockRejectedValue(new Error("DB Error"));

            await TaskManager.addTask(target, mediaMessage, userId);

            expect(mockClient.editMessage).toHaveBeenCalled();
        });
    });

    describe("addBatchTasks (multiple)", () => {
        beforeEach(() => {
            TaskManager.queue.pause();
        });

        test("should add batch tasks correctly using createBatch", async () => {
            const target = "chat123";
            const messages = [{ id: 201, groupedId: "g1" }, { id: 202, groupedId: "g1" }];
            const userId = "user456";

            mockClient.sendMessage.mockResolvedValue({ id: 300 });
            mockTaskRepository.createBatch.mockResolvedValue(true);

            await TaskManager.addBatchTasks(target, messages, userId);

            expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
            expect(mockTaskRepository.createBatch).toHaveBeenCalled();
            expect(TaskManager.waitingTasks.length).toBe(2);
            expect(TaskManager.waitingTasks[0].isGroup).toBe(true);
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

        test("should cancel task if has permission", async () => {
            const taskId = "task1";
            const userId = "admin";
            mockTaskRepository.findById.mockResolvedValue({ user_id: "other_user" });
            mockAuthGuard.can.mockResolvedValue(true);

            const result = await TaskManager.cancelTask(taskId, userId);

            expect(result).toBe(true);
        });

        test("should deny cancellation if no permission", async () => {
            const taskId = "task1";
            const userId = "user2";
            mockTaskRepository.findById.mockResolvedValue({ user_id: "user1" });
            mockAuthGuard.can.mockResolvedValue(false);

            const result = await TaskManager.cancelTask(taskId, userId);

            expect(result).toBe(false);
        });
    });

    describe("fileWorker", () => {
        test("should handle successful transfer", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                isCancelled: false,
                lastText: ""
            };

            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce(null); // No sec transfer
            mockClient.downloadMedia.mockResolvedValue("path/to/file");
            mockCloudTool.uploadBatch.mockImplementation(async (tasks, onProgress) => {
                tasks.forEach(t => {
                   if (t.onUploadComplete) t.onUploadComplete({ success: true });
                });
                return { success: true };
            });
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Size: 1024 }); // Final check

            await TaskManager.fileWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "completed");
            expect(updateStatus).toHaveBeenLastCalledWith(task, expect.stringContaining("success"), true);
        }, 10000);

        test("should handle second transfer (秒传)", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                isCancelled: false
            };

            mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Size: 1024 });

            await TaskManager.fileWorker(task);

            expect(mockClient.downloadMedia).not.toHaveBeenCalled();
            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "completed");
        });

        test("should handle cancellation during execution", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                isCancelled: true
            };

            await TaskManager.fileWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "cancelled", "CANCELLED");
        });
    });

    describe("_refreshGroupMonitor", () => {
        test("should update group monitor correctly", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "123456789", // 字符串格式
                msgId: "100",
                isGroup: true
            };
            const groupTasks = [{ file_name: "f1", status: "downloading" }];
            mockTaskRepository.findByMsgId.mockResolvedValue(groupTasks);
            
            await TaskManager._refreshGroupMonitor(task, "downloading", 100, 1000);
            
            expect(mockTaskRepository.findByMsgId).toHaveBeenCalledWith("100");
            expect(mockUIHelper.renderBatchMonitor).toHaveBeenCalled();
            expect(mockClient.editMessage).toHaveBeenCalledWith(BigInt("123456789"), expect.any(Object));
        });

        test("should handle editMessage error", async () => {
            const task = { id: "t1", msgId: "100", chatId: "123", isGroup: true };
            mockTaskRepository.findByMsgId.mockResolvedValue([{status: "downloading"}]);
            mockClient.editMessage.mockRejectedValue(new Error("API Error"));
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

            await TaskManager._refreshGroupMonitor(task, "downloading");

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[Monitor Update Error]"), "API Error");
            consoleSpy.mockRestore();
        });

        test("should honor UI throttling", async () => {
            const task = { msgId: "100" };
            TaskManager.monitorLocks.set("100", Date.now()); // 最近刚更新过
            
            await TaskManager._refreshGroupMonitor(task, "downloading");
            
            expect(mockTaskRepository.findByMsgId).not.toHaveBeenCalled();
        });

        test("should bypass throttling for final status", async () => {
            const task = { msgId: "100", chatId: "123", isGroup: true };
            TaskManager.monitorLocks.set("100", Date.now());
            mockTaskRepository.findByMsgId.mockResolvedValue([{status: "completed"}]);
            
            await TaskManager._refreshGroupMonitor(task, "completed");
            
            expect(mockTaskRepository.findByMsgId).toHaveBeenCalled();
        });
    });

    describe("AutoScaling", () => {
        test("should start and stop auto scaling", async () => {
            const setIntervalSpy = jest.spyOn(global, "setInterval");
            const clearIntervalSpy = jest.spyOn(global, "clearInterval");

            TaskManager.startAutoScaling();
            
            // 给异步 import 一点时间
            await new Promise(resolve => setTimeout(resolve, 100));
            
            expect(setIntervalSpy).toHaveBeenCalled();
            expect(TaskManager.autoScalingInterval).not.toBeNull();

            TaskManager.stopAutoScaling();
            expect(clearIntervalSpy).toHaveBeenCalled();
            expect(TaskManager.autoScalingInterval).toBeNull();
            
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
        });
    });

    describe("updateQueueUI", () => {
        test("should update UI for waiting tasks", async () => {
            // 避免使用 fake timers，因为 PQueue 和其他异步逻辑可能受影响
            const task = { id: "1", lastText: "", isGroup: false };
            TaskManager.waitingTasks = [task];
            
            // 临时 mock updateStatus 以立即解决
            updateStatus.mockResolvedValue(true);

            await TaskManager.updateQueueUI();
            
            expect(updateStatus).toHaveBeenCalledWith(task, expect.stringContaining("queued"));
            expect(task.lastText).toContain("queued");
        });

        test("should skip group tasks in queue UI", async () => {
            const task = { id: "1", isGroup: true };
            TaskManager.waitingTasks = [task];
            
            await TaskManager.updateQueueUI();
            
            expect(updateStatus).not.toHaveBeenCalled();
        });
    });
});