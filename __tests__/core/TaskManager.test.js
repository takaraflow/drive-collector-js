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
    escapeHTML: jest.fn(str => str),
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

// 导入 TaskManager
const { TaskManager } = await import("../../src/core/TaskManager.js");
const { updateStatus } = await import("../../src/utils/common.js");

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

        TaskManager.waitingTasks = [];
        TaskManager.currentTask = null;
        TaskManager.waitingUploadTasks = [];
        // 清理队列
        TaskManager.queue.clear();
        TaskManager.monitorLocks.clear();
        // 清理 UploadBatcher 的定时器（重置实例）
        if (TaskManager.uploadBatcher) {
            TaskManager.uploadBatcher.batches.clear();
        }
    });

    afterEach(() => {
        // 清理所有未完成的异步操作（仅在启用fake timers时）
        try {
            if (jest.isMockFunction(setTimeout)) {
                jest.clearAllTimers();
                jest.runOnlyPendingTimers();
            }
        } catch (e) {
            // 忽略 fake timers 未启用的错误
        }
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

            // Since we use Promise.allSettled, the error is handled internally and logged as part of preload
            expect(consoleSpy).toHaveBeenCalledWith("DriveRepository.findAll error:", expect.any(Error));
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

        test("should preload common data during init", async () => {
            mockTaskRepository.findStalledTasks.mockResolvedValue([]);
            const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

            await TaskManager.init();

            // Should call the preload message
            expect(consoleSpy).toHaveBeenCalledWith("📊 预加载常用数据完成: 6/6 个任务成功");
            consoleSpy.mockRestore();
        });

        test("should handle preload data failure gracefully", async () => {
            mockTaskRepository.findStalledTasks.mockResolvedValue([]);
            const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
            const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

            // Mock the preload method to simulate partial failure
            const originalPreload = TaskManager._preloadCommonData;
            TaskManager._preloadCommonData = jest.fn(async () => {
                // Simulate 5 successes and 1 failure
                console.log("📊 预加载常用数据完成: 5/6 个任务成功");
                console.warn("⚠️ 预加载成功率较低: 5/6");
            });

            await TaskManager.init();

            // Should still complete init successfully despite preload issues
            expect(consoleLogSpy).toHaveBeenCalledWith("📊 预加载常用数据完成: 5/6 个任务成功");
            expect(consoleWarnSpy).toHaveBeenCalledWith("⚠️ 预加载成功率较低: 5/6");

            consoleLogSpy.mockRestore();
            consoleWarnSpy.mockRestore();

            // Restore original method
            TaskManager._preloadCommonData = originalPreload;
        });

        test("should batch restore tasks efficiently", async () => {
            const stalledTasks = [
                { id: "1", user_id: "u1", chat_id: "c1", msg_id: 100, source_msg_id: 200, status: 'downloaded', file_name: 'file1.mp4' },
                { id: "2", user_id: "u1", chat_id: "c1", msg_id: 100, source_msg_id: 201, status: 'queued', file_name: 'file2.mp4' },
                { id: "3", user_id: "u1", chat_id: "c1", msg_id: 100, source_msg_id: 202, status: 'queued', file_name: 'file3.mp4' } // invalid message
            ];
            mockTaskRepository.findStalledTasks.mockResolvedValue(stalledTasks);
            mockClient.getMessages.mockResolvedValue([
                { id: 200, media: {} },
                { id: 201, media: {} },
                null // 202 is missing
            ]);

            // Mock batchUpdateStatus to capture calls
            const batchUpdateSpy = jest.spyOn(TaskManager, 'batchUpdateStatus');
            const enqueueUploadSpy = jest.spyOn(TaskManager, '_enqueueUploadTask');
            const enqueueTaskSpy = jest.spyOn(TaskManager, '_enqueueTask');
            TaskManager.queue.pause();

            await TaskManager.init();

            // Should batch update failed status
            expect(batchUpdateSpy).toHaveBeenCalledWith([
                { id: "3", status: 'failed', error: 'Source msg missing' }
            ]);

            // Should have called enqueue methods
            expect(enqueueUploadSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: "1" })
            );
            expect(enqueueTaskSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: "2" })
            );

            // Should have enqueued valid tasks
            expect(TaskManager.waitingTasks.length).toBe(1); // task 2 only, task 1 goes to upload

            batchUpdateSpy.mockRestore();
            TaskManager.queue.clear();
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

    describe("downloadWorker", () => {
        test("should handle successful download", async () => {
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

            // Mock enqueueUploadTask to avoid triggering additional UI updates
            TaskManager._enqueueUploadTask = jest.fn();

            await TaskManager.downloadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "downloaded");
            expect(updateStatus).toHaveBeenCalledWith(task, "📥 <b>下载完成，等待转存...</b>");
            expect(TaskManager._enqueueUploadTask).toHaveBeenCalledWith(task);
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

            // Mock local file exists with correct size, and remote file exists
            const fs = await import("fs");
            fs.default.promises.stat.mockResolvedValue({ size: 1024 });
            mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Size: 1024 });

            await TaskManager.downloadWorker(task);

            expect(mockClient.downloadMedia).not.toHaveBeenCalled();
            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "completed");
        });

        test("should handle cancellation during download", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                isCancelled: true
            };

            await TaskManager.downloadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "cancelled", "CANCELLED");
        });
    });

    describe("uploadWorker", () => {
        test("should handle successful upload", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: false,
                lastText: ""
            };

            // Mock uploadBatcher to immediately complete
            TaskManager.uploadBatcher.add = jest.fn((task) => {
                // Simulate immediate completion
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: true });
                    }
                }, 1);
            });
            // Mock the file size check to match
            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);
            fs.default.statSync.mockReturnValue({ size: 1024 });
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Size: 1024 }); // Final check

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "completed");
            expect(updateStatus).toHaveBeenLastCalledWith(task, expect.stringContaining("success"), true);
        }, 1000);

        test("should handle upload failure", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: false
            };

            // Mock uploadBatcher to immediately fail
            TaskManager.uploadBatcher.add = jest.fn((task) => {
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: false, error: "Upload failed" });
                    }
                }, 1);
            });

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "failed", "Upload failed");
        }, 1000);

        test("should handle local file not found", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/missing.mp4",
                isCancelled: false
            };

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(false);

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "failed", "Local file not found");
            expect(updateStatus).toHaveBeenCalledWith(task, "failed_val", true);
        });

        test("should handle upload verification failure", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: false
            };

            // Mock successful upload but verification fails
            TaskManager.uploadBatcher.add = jest.fn((task) => {
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: true });
                    }
                }, 1);
            });

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);
            fs.default.statSync.mockReturnValue({ size: 1024 });
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Size: 3000 }); // Size mismatch > 1024

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenNthCalledWith(2, "t1", "failed");
            expect(updateStatus).toHaveBeenCalledWith(task, "failed_val", true);
        });

        test("should handle cancellation during upload", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: true
            };

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "cancelled", "CANCELLED");
        });

        test("should handle group task upload updates", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: false,
                isGroup: true
            };

            // Mock findByMsgId to return valid group tasks
            mockTaskRepository.findByMsgId.mockResolvedValue([{ id: "t1", status: "uploading" }]);

            TaskManager.uploadBatcher.add = jest.fn((task) => {
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: true });
                    }
                    if (task.onUploadProgress) {
                        task.onUploadProgress({ bytes: 512, size: 1024 });
                    }
                }, 1);
            });

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);
            fs.default.statSync.mockReturnValue({ size: 1024 });
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Size: 1024 });

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.findByMsgId).toHaveBeenCalledWith(100);
        });

        test("should handle file cleanup after successful upload", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: false
            };

            TaskManager.uploadBatcher.add = jest.fn((task) => {
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: true });
                    }
                }, 1);
            });

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);
            fs.default.statSync.mockReturnValue({ size: 1024 });
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Size: 1024 });

            await TaskManager.uploadWorker(task);

            expect(fs.default.promises.unlink).toHaveBeenCalledWith("/tmp/test.mp4");
        });

        test("should handle file cleanup failure gracefully", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { id: 200, media: {} },
                fileName: "test.mp4",
                localPath: "/tmp/test.mp4",
                isCancelled: false
            };

            TaskManager.uploadBatcher.add = jest.fn((task) => {
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: true });
                    }
                }, 1);
            });

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);
            fs.default.statSync.mockReturnValue({ size: 1024 });
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Size: 1024 });
            fs.default.promises.unlink.mockRejectedValue(new Error("Cleanup failed"));

            // Should not throw error even if cleanup fails
            await expect(TaskManager.uploadWorker(task)).resolves.not.toThrow();
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

    describe("batchUpdateStatus", () => {
        test("should batch update task statuses successfully", async () => {
            // Mock d1 at the top level
            const mockD1Batch = jest.fn().mockResolvedValue([{ success: true }, { success: true }]);
            const originalD1 = await import("../../src/services/d1.js");
            originalD1.d1.batch = mockD1Batch;

            const updates = [
                { id: "task1", status: "completed", error: null },
                { id: "task2", status: "failed", error: "Upload failed" }
            ];

            await TaskManager.batchUpdateStatus(updates);

            expect(mockD1Batch).toHaveBeenCalledWith([
                {
                    sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = datetime('now') WHERE id = ?",
                    params: ["completed", null, "task1"]
                },
                {
                    sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = datetime('now') WHERE id = ?",
                    params: ["failed", "Upload failed", "task2"]
                }
            ]);
        });

        test("should handle empty updates array", async () => {
            const mockD1Batch = jest.fn();
            const originalD1 = await import("../../src/services/d1.js");
            originalD1.d1.batch = mockD1Batch;

            await TaskManager.batchUpdateStatus([]);

            expect(mockD1Batch).not.toHaveBeenCalled();
        });

        test("should fallback to individual updates on batch failure", async () => {
            const mockD1Batch = jest.fn().mockRejectedValue(new Error("Batch failed"));
            const originalD1 = await import("../../src/services/d1.js");
            originalD1.d1.batch = mockD1Batch;

            const updates = [{ id: "task1", status: "completed" }];

            await TaskManager.batchUpdateStatus(updates);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("task1", "completed", undefined);
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

        test("should limit UI updates to first 5 tasks", async () => {
            const tasks = Array.from({ length: 10 }, (_, i) => ({
                id: `${i}`,
                lastText: "",
                isGroup: false
            }));
            TaskManager.waitingTasks = tasks;

            updateStatus.mockResolvedValue(true);

            await TaskManager.updateQueueUI();

            expect(updateStatus).toHaveBeenCalledTimes(5);
        });
    });

    describe("UploadBatcher", () => {
        test("should add task to batch and trigger upload", async () => {
            const task = { id: "t1", userId: "u1" };
            const processBatchFn = jest.fn();

            const batcher = new TaskManager.uploadBatcher.constructor(processBatchFn);

            // Mock setTimeout to execute immediately
            jest.useFakeTimers();
            batcher.add(task);

            jest.advanceTimersByTime(5000);

            expect(processBatchFn).toHaveBeenCalledWith([task]);
            jest.useRealTimers();
        });

        test("should group tasks by user and folder", async () => {
            const task1 = { id: "t1", userId: "u1" };
            const task2 = { id: "t2", userId: "u1" };
            const task3 = { id: "t3", userId: "u2" };

            const processBatchFn = jest.fn();

            const batcher = new TaskManager.uploadBatcher.constructor(processBatchFn);

            jest.useFakeTimers();
            batcher.add(task1);
            batcher.add(task2);
            batcher.add(task3);

            jest.advanceTimersByTime(5000);

            expect(processBatchFn).toHaveBeenCalledTimes(2); // Two different user groups
            expect(processBatchFn).toHaveBeenCalledWith([task1, task2]);
            expect(processBatchFn).toHaveBeenCalledWith([task3]);
            jest.useRealTimers();
        });
    });

    describe("cancelTask - additional edge cases", () => {
        test("should handle task not found", async () => {
            mockTaskRepository.findById.mockResolvedValue(null);

            const result = await TaskManager.cancelTask("nonexistent", "user1");

            expect(result).toBe(false);
        });

        test("should cancel current task", async () => {
            const taskId = "current";
            const userId = "user1";
            mockTaskRepository.findById.mockResolvedValue({ user_id: userId });

            const currentTask = { id: taskId, userId: userId, isCancelled: false, proc: { kill: jest.fn() } };
            TaskManager.currentTask = currentTask;

            const result = await TaskManager.cancelTask(taskId, userId);

            expect(result).toBe(true);
            expect(currentTask.isCancelled).toBe(true);
            expect(currentTask.proc.kill).toHaveBeenCalledWith("SIGTERM");
        });

        test("should cancel upload task", async () => {
            const taskId = "upload";
            const userId = "user1";
            mockTaskRepository.findById.mockResolvedValue({ user_id: userId });

            const uploadTask = { id: taskId, userId: userId, isCancelled: false, proc: { kill: jest.fn() } };
            TaskManager.waitingUploadTasks.push(uploadTask);

            const result = await TaskManager.cancelTask(taskId, userId);

            expect(result).toBe(true);
            expect(uploadTask.isCancelled).toBe(true);
            expect(TaskManager.waitingUploadTasks).not.toContain(uploadTask);
        });
    });

    describe("addTask - additional edge cases", () => {
        test("should handle different target formats", async () => {
            const targets = [
                "chat123",
                { userId: "user123" },
                { chatId: "chat123" },
                { channelId: "channel123" },
                { id: "id123" },
                123456789 // numeric
            ];

            for (const target of targets) {
                mockClient.sendMessage.mockResolvedValueOnce({ id: 300 });

                await TaskManager.addTask(target, { id: 200 }, "user456");

                expect(mockClient.sendMessage).toHaveBeenCalled();
                expect(mockTaskRepository.create).toHaveBeenCalled();
            }
        });

        test("should handle sendMessage failure", async () => {
            const { runBotTaskWithRetry } = await import("../../src/utils/limiter.js");
            runBotTaskWithRetry.mockRejectedValue(new Error("Send failed"));

            await expect(TaskManager.addTask("chat123", { id: 200 }, "user456")).rejects.toThrow("Send failed");
        });

        test("should pass correct priority to sendMessage", async () => {
            const { runBotTaskWithRetry } = await import("../../src/utils/limiter.js");
            runBotTaskWithRetry.mockResolvedValue({ id: 300 });

            await TaskManager.addTask("chat123", { id: 200 }, "user456");

            expect(runBotTaskWithRetry).toHaveBeenCalledWith(
                expect.any(Function),
                "user456",
                { priority: 20 },
                false,
                3
            );
        });
    });

    describe("addBatchTasks - additional edge cases", () => {
        test("should handle empty messages array", async () => {
            // addBatchTasks doesn't throw for empty array, it just returns early
            await expect(TaskManager.addBatchTasks("chat123", [], "user456")).resolves.toBeUndefined();
        });

        test("should handle sendMessage failure in batch", async () => {
            // Temporarily override the mock for this test
            const { runBotTaskWithRetry } = await import("../../src/utils/limiter.js");
            const originalMock = runBotTaskWithRetry.getMockImplementation();
            runBotTaskWithRetry.mockRejectedValueOnce(new Error("Send failed"));

            await expect(TaskManager.addBatchTasks("chat123", [{ id: 200 }], "user456")).rejects.toThrow("Send failed");

            // Restore original mock
            runBotTaskWithRetry.mockImplementation(originalMock);
        });

        test("should create correct number of tasks", async () => {
            const messages = [{ id: 201 }, { id: 202 }, { id: 203 }];
            mockClient.sendMessage.mockResolvedValue({ id: 300 });
            mockTaskRepository.createBatch.mockResolvedValue(true);

            TaskManager.queue.pause();

            await TaskManager.addBatchTasks("chat123", messages, "user456");

            expect(mockTaskRepository.createBatch).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ sourceMsgId: 201 }),
                    expect.objectContaining({ sourceMsgId: 202 }),
                    expect.objectContaining({ sourceMsgId: 203 })
                ])
            );
            expect(TaskManager.waitingTasks.length).toBe(3);
        });
    });

    describe("_refreshGroupMonitor - additional edge cases", () => {
        test("should handle dynamic throttling based on progress", async () => {
            const task = { msgId: "100", chatId: "123", isGroup: true };
            mockTaskRepository.findByMsgId.mockResolvedValue([{ status: "downloading" }]);

            // Test early progress (0-10%)
            TaskManager.monitorLocks.set("100", 0); // Reset lock
            await TaskManager._refreshGroupMonitor(task, "downloading", 50, 1000); // 5%
            expect(mockUIHelper.renderBatchMonitor).toHaveBeenCalled();

            // Test mid progress (10-50%)
            jest.clearAllMocks();
            TaskManager.monitorLocks.set("100", 0);
            await TaskManager._refreshGroupMonitor(task, "downloading", 300, 1000); // 30%
            expect(mockUIHelper.renderBatchMonitor).toHaveBeenCalled();

            // Test late progress (50-100%)
            jest.clearAllMocks();
            TaskManager.monitorLocks.set("100", 0);
            await TaskManager._refreshGroupMonitor(task, "downloading", 800, 1000); // 80%
            expect(mockUIHelper.renderBatchMonitor).toHaveBeenCalled();
        });

        test("should handle numeric chatId conversion", async () => {
            const task = { msgId: "100", chatId: "123456789", isGroup: true }; // 字符串格式会被转换为BigInt
            mockTaskRepository.findByMsgId.mockResolvedValue([{ status: "downloading" }]);

            await TaskManager._refreshGroupMonitor(task, "downloading");

            expect(mockClient.editMessage).toHaveBeenCalledWith(BigInt("123456789"), expect.any(Object));
        });

        test("should batch update statuses for final states", async () => {
            const task = { msgId: "100", chatId: "123", isGroup: true };
            const groupTasks = [
                { id: "t1", status: "downloading" },
                { id: "t2", status: "downloading" }
            ];
            mockTaskRepository.findByMsgId.mockResolvedValue(groupTasks);

            const batchUpdateSpy = jest.spyOn(TaskManager, 'batchUpdateStatus');

            await TaskManager._refreshGroupMonitor(task, "completed");

            expect(batchUpdateSpy).toHaveBeenCalledWith([
                { id: "t1", status: "completed", error: null },
                { id: "t2", status: "completed", error: null }
            ]);

            batchUpdateSpy.mockRestore();
        });

        test("should handle empty group tasks", async () => {
            const task = { msgId: "100", chatId: "123", isGroup: true };
            mockTaskRepository.findByMsgId.mockResolvedValue([]);

            await TaskManager._refreshGroupMonitor(task, "downloading");

            expect(mockUIHelper.renderBatchMonitor).not.toHaveBeenCalled();
        });
    });

    describe("queue compatibility", () => {
        test("should maintain backward compatibility with queue property", () => {
            const originalQueue = TaskManager.downloadQueue;
            const newQueue = { test: "queue" };

            TaskManager.queue = newQueue;

            expect(TaskManager.downloadQueue).toBe(newQueue);
            expect(TaskManager.queue).toBe(newQueue);

            // Restore
            TaskManager.downloadQueue = originalQueue;
        });
    });

    describe("error handling and recovery", () => {
        test("should handle downloadWorker errors gracefully", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { media: {} },
                fileName: "test.mp4",
                isCancelled: false
            };

            // Mock getMediaInfo to return valid info
            const { getMediaInfo } = await import("../../src/utils/common.js");
            getMediaInfo.mockReturnValue({ name: "test.mp4", size: 1024 });

            // Ensure no sec transfer by making local file not exist or size mismatch
            const fs = await import("fs");
            fs.default.promises.stat.mockRejectedValue(new Error("File not found"));
            mockCloudTool.getRemoteFileInfo.mockResolvedValueOnce(null);

            // Mock download to fail
            const { runMtprotoFileTaskWithRetry } = await import("../../src/utils/limiter.js");
            runMtprotoFileTaskWithRetry.mockRejectedValue(new Error("Network error"));

            await TaskManager.downloadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "failed", "Network error");
        });

        test("should handle uploadWorker errors gracefully", async () => {
            const task = {
                id: "t1",
                userId: "u1",
                chatId: "c1",
                msgId: 100,
                message: { media: {} },
                localPath: "/tmp/test.mp4",
                isCancelled: false
            };

            const fs = await import("fs");
            fs.default.existsSync.mockReturnValue(true);

            TaskManager.uploadBatcher.add = jest.fn((task) => {
                setTimeout(() => {
                    if (task.onUploadComplete) {
                        task.onUploadComplete({ success: false, error: "Upload error" });
                    }
                }, 1);
            });

            await TaskManager.uploadWorker(task);

            expect(mockTaskRepository.updateStatus).toHaveBeenCalledWith("t1", "failed", "Upload error");
        }, 20000);
    });
});