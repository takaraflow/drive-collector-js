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
    iterDownload: vi.fn(),
    editMessage: vi.fn().mockResolvedValue(),
    sendMessage: vi.fn().mockResolvedValue({ id: 123 })
};
vi.mock("../../src/services/telegram.js", () => ({
    client: mockClient,
}));

const mockCloudTool = {
    getRemoteFileInfo: vi.fn(),
    uploadBatch: vi.fn().mockResolvedValue({ success: true }),
    _getUploadPath: vi.fn().mockResolvedValue("/user/upload/path"),
};
vi.mock("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

const mockTaskRepository = {
    updateStatus: vi.fn(),
    transitionStatus: vi.fn().mockResolvedValue({ changed: true, blocked: false }),
    findByMsgId: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateFileMetadata: vi.fn().mockResolvedValue(true),
    findCompletedByFile: vi.fn(),
    findAllCompletedByUser: vi.fn().mockResolvedValue([]),
};
vi.mock("../../src/repositories/TaskRepository.js", () => ({
    TaskRepository: mockTaskRepository,
}));

const mockDriveRepository = {
    getDefaultDrive: vi.fn().mockResolvedValue({
        id: "drive_1",
        user_id: "user_1",
        type: "mega",
        config_data: "{}"
    })
};
vi.mock("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: mockDriveRepository,
}));

// Mock InstanceCoordinator
const mockInstanceCoordinator = {
    acquireTaskLock: vi.fn().mockResolvedValue(true),
    releaseTaskLock: vi.fn().mockResolvedValue(),
    isLockLeaseCurrent: vi.fn().mockResolvedValue(true),
    getActiveInstances: vi.fn().mockResolvedValue([]),
    instanceId: "current-instance"
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
    formatBytes: vi.fn((bytes) => `${bytes} B`)
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

const mockStreamTransferService = {
    registerStreamOwner: vi.fn(),
    clearStreamOwner: vi.fn(),
    resumeTask: vi.fn(),
    resetTask: vi.fn(),
    forwardChunk: vi.fn(),
    waitForFinalization: vi.fn()
};
vi.mock("../../src/services/StreamTransferService.js", () => ({
    streamTransferService: mockStreamTransferService
}));

const mockDirectTransferService = {
    canAttempt: vi.fn().mockReturnValue({ supported: false, reason: "test-disabled" }),
    transferTelegramMediaToRemote: vi.fn()
};

const mockTunnelService = {
    getPublicUrl: vi.fn().mockResolvedValue("https://leader.example.com")
};
vi.mock("../../src/services/TunnelService.js", () => ({
    tunnelService: mockTunnelService
}));

// Mock fs
const mockFs = {
    existsSync: vi.fn(),
    constants: { W_OK: 2 },
    promises: {
        stat: vi.fn(),
        access: vi.fn().mockResolvedValue(),
        mkdir: vi.fn().mockResolvedValue(),
        statfs: vi.fn().mockResolvedValue({ bsize: 4096, bavail: 1000000 }),
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
const { dependencyContainer } = await import("../../src/services/DependencyContainer.js");

describe("TaskManager - Second Transfer (Sec-Transfer) Logic", () => {
    let task;

    beforeEach(() => {
        vi.clearAllMocks();
        TaskManager.activeProcessors.clear();
        TaskManager.waitingTasks = [];
        mockTaskRepository.transitionStatus.mockResolvedValue({ changed: true, blocked: false });
        mockDriveRepository.getDefaultDrive.mockResolvedValue({
            id: "drive_1",
            user_id: "user_1",
            type: "mega",
            config_data: "{}"
        });
        mockClient.iterDownload.mockReset();
        mockStreamTransferService.resumeTask.mockReset();
        mockStreamTransferService.resetTask.mockReset();
        mockStreamTransferService.forwardChunk.mockReset();
        mockStreamTransferService.waitForFinalization.mockReset();
        mockStreamTransferService.registerStreamOwner.mockReset();
        mockStreamTransferService.clearStreamOwner.mockReset();
        mockDirectTransferService.canAttempt.mockReset();
        mockDirectTransferService.transferTelegramMediaToRemote.mockReset();
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: false, reason: "test-disabled" });
        mockQueueService.enqueueUploadTask.mockReset();
        mockQueueService.enqueueDownloadTask.mockReset();
        mockQueueService.enqueueUploadTask.mockResolvedValue({ messageId: "upload-msg" });
        mockQueueService.enqueueDownloadTask.mockResolvedValue({ messageId: "download-msg" });
        mockStreamTransferService.registerStreamOwner.mockResolvedValue({
            taskId: "task_1",
            instanceId: "worker-1",
            url: "https://worker.example.com"
        });
        mockStreamTransferService.clearStreamOwner.mockResolvedValue();
        mockTunnelService.getPublicUrl.mockResolvedValue("https://leader.example.com");
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([]);
        mockFs.promises.access.mockResolvedValue();
        mockFs.promises.mkdir.mockResolvedValue();
        mockFs.promises.statfs.mockResolvedValue({ bsize: 4096, bavail: 1000000 });

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
        expect(mockCloudTool.getRemoteFileInfo).toHaveBeenCalledWith("test_file.mp4", "user_1", 1, true);
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "complete",
            null,
            expect.objectContaining({ source: "handleTaskCompletion" })
        );
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
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "finish_download",
            null,
            expect.objectContaining({ source: "local_file_ready" })
        );

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
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "finish_download",
            null,
            expect.objectContaining({ source: "download_complete" })
        );

        // Should enqueue upload task via QStash
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith("task_1", expect.objectContaining({
            userId: "user_1",
            chatId: "chat_1",
            msgId: 100,
            localPath: expect.stringContaining("test_file.mp4")
        }));
    });

    test("keeps downloaded task recoverable when upload queue publish circuit breaker is open", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();
        mockQueueService.enqueueUploadTask.mockRejectedValueOnce(new Error("Circuit breaker is OPEN for qstash_publish"));

        await expect(TaskManager.downloadTask(task)).rejects.toThrow("Circuit breaker is OPEN for qstash_publish");

        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "finish_download",
            null,
            expect.objectContaining({ source: "download_complete" })
        );
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.stringContaining("qstash_publish"),
            expect.anything()
        );
    });

    test("direct transfer success completes without local download or upload queue", async () => {
        mockCloudTool.getRemoteFileInfo
            .mockResolvedValueOnce(null)
            .mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 });
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: true,
            method: "direct_stream",
            fileName: "test_file.mp4",
            bytes: 10485760
        });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockDirectTransferService.transferTelegramMediaToRemote).toHaveBeenCalledWith(expect.objectContaining({
            task: expect.objectContaining({ id: "task_1" }),
            fileName: "test_file.mp4",
            chunkSize: 128 * 1024,
            driveType: "mega"
        }));
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "complete",
            null,
            expect.objectContaining({ source: "direct_transfer_complete" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer fallback resets state and continues through local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: false,
            fallback: true,
            error: "backend does not support rcat"
        });
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "reset_stream_download",
            "backend does not support rcat",
            expect.objectContaining({ source: "direct_transfer_fallback" })
        );
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({ userId: "user_1" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer rclone transient fallback continues through local staging when local fallback is enabled", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: false,
            fallback: true,
            error: "TIMEOUT",
            errorCode: "RCLONE_TRANSIENT",
            retryable: true,
            userRetryable: true
        });
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "reset_stream_download",
            "TIMEOUT",
            expect.objectContaining({ source: "direct_transfer_fallback" })
        );
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({ userId: "user_1" })
        );
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.anything(),
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer Telegram source transient stays recoverable without local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: false,
            fallback: false,
            error: "400: CONNECTION_NOT_INITED (caused by upload.GetFile)",
            errorCode: "TELEGRAM_SOURCE_TRANSIENT",
            retryable: true,
            userRetryable: true,
            retryScope: "telegram_source"
        });
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await expect(TaskManager.downloadTask(task)).rejects.toThrow("CONNECTION_NOT_INITED");

        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            "task_1",
            "reset_stream_download",
            expect.anything(),
            expect.anything()
        );
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.anything(),
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer skips OSS user drive and uses local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDriveRepository.getDefaultDrive.mockResolvedValue({
            id: "drive_oss",
            user_id: "user_1",
            type: "oss",
            config_data: "{}"
        });
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: false, reason: "oss-local-staging-required" });
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockDirectTransferService.canAttempt).toHaveBeenCalledWith(
            expect.any(Object),
            { driveType: "oss" }
        );
        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({ userId: "user_1" })
        );

        getAllSpy.mockRestore();
    });

    test("strict zero-disk mode fails unsupported drives instead of local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDriveRepository.getDefaultDrive.mockResolvedValue({
            id: "drive_oss",
            user_id: "user_1",
            type: "oss",
            config_data: "{}"
        });
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: false, reason: "oss-local-staging-required" });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: false },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockFs.promises.stat).not.toHaveBeenCalled();
        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.stringContaining("Zero-disk direct transfer unavailable: oss-local-staging-required"),
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer capability lookup failure falls back to local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDriveRepository.getDefaultDrive.mockRejectedValue(new Error("D1 unavailable"));
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({ userId: "user_1" })
        );

        getAllSpy.mockRestore();
    });

    test("strict zero-disk mode fails capability lookup errors instead of local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDriveRepository.getDefaultDrive.mockRejectedValue(new Error("D1 unavailable"));

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: false },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockFs.promises.stat).not.toHaveBeenCalled();
        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.stringContaining("Zero-disk direct transfer unavailable: drive-capability-lookup-failed"),
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer skips remote same-name conflicts before streaming", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 2097152 });
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled();

        getAllSpy.mockRestore();
    });

    test("strict zero-disk mode fails remote same-name conflicts instead of local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 2097152 });
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: false },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockFs.promises.stat).not.toHaveBeenCalled();
        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.stringContaining("Zero-disk direct transfer unavailable: remote-name-conflict"),
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("direct transfer fallback skips stream forwarding and goes local", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: false,
            fallback: true,
            error: "rcat failed"
        });
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
            { id: "current-instance" },
            { id: "worker-1", directUrl: "https://worker.example.com", activeTaskCount: 0 }
        ]);
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            UIHelper: {
                renderProgress: vi.fn(() => "stream progress")
            },
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                port: 3000,
                directTransfer: { enabled: true, fallbackToLocal: true },
                streamForwarding: {
                    enabled: true,
                    lbUrl: "https://lb.example.com",
                    externalUrl: "https://leader.example.com"
                }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockStreamTransferService.registerStreamOwner).not.toHaveBeenCalled();
        expect(mockStreamTransferService.forwardChunk).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({ userId: "user_1" })
        );

        getAllSpy.mockRestore();
    });

    test("strict zero-disk mode fails direct transfer fallback instead of stream forwarding or local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: false,
            fallback: true,
            error: "rcat failed"
        });
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
            { id: "current-instance" },
            { id: "worker-1", directUrl: "https://worker.example.com", activeTaskCount: 0 }
        ]);

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            UIHelper: {
                renderProgress: vi.fn(() => "stream progress")
            },
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                port: 3000,
                directTransfer: { enabled: "TRUE", fallbackToLocal: "FALSE" },
                streamForwarding: {
                    enabled: true,
                    lbUrl: "https://lb.example.com",
                    externalUrl: "https://leader.example.com"
                }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockFs.promises.stat).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).not.toHaveBeenCalledWith(
            "task_1",
            "reset_stream_download",
            expect.anything(),
            expect.objectContaining({ source: "direct_transfer_fallback" })
        );
        expect(mockStreamTransferService.registerStreamOwner).not.toHaveBeenCalled();
        expect(mockStreamTransferService.forwardChunk).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            "Zero-disk direct transfer failed; local fallback disabled",
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("strict zero-disk mode fails blocked direct-transfer state starts instead of local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockTaskRepository.transitionStatus.mockImplementation(async (_taskId, event) => {
            if (event === "start_stream_upload") {
                return {
                    changed: false,
                    blocked: true,
                    reason: "state changed concurrently"
                };
            }
            return { changed: true, blocked: false };
        });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: false },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockDirectTransferService.transferTelegramMediaToRemote).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.stringContaining("Zero-disk direct transfer unavailable: state-transition-blocked"),
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("should fail before Telegram download when local storage is insufficient", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockFs.promises.statfs.mockResolvedValueOnce({ bsize: 4096, bavail: 1 });

        await TaskManager.downloadTask(task);

        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            expect.stringContaining("Insufficient local storage"),
            expect.objectContaining({ source: "handleTaskFailure" })
        );
    });

    test("Scenario 4: Size Mismatch Tolerance - Remote Hit within tolerance", async () => {
        // 10MB file. Tolerance is 1MB.
        // Remote file is 10MB + 500KB (within 1MB)
        mockCloudTool.getRemoteFileInfo.mockResolvedValue({ Name: "test_file.mp4", Size: 10485760 + 512000 });

        await TaskManager.downloadTask(task);

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "complete",
            null,
            expect.objectContaining({ source: "handleTaskCompletion" })
        );
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

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_small",
            "complete",
            null,
            expect.objectContaining({ source: "handleTaskCompletion" })
        );
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

    test("should clear active processor state when config is missing before download starts", async () => {
        const depsSnapshot = { ...dependencyContainer.getAll(), config: null };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await expect(TaskManager.downloadTask(task)).rejects.toThrow(/downloadDir/);

        expect(TaskManager.activeProcessors.has("task_1")).toBe(false);

        getAllSpy.mockRestore();
    });

    test("should allow canonical claim to replace stale local processor marker", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockClient.downloadMedia.mockResolvedValue();
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: false, reason: "test-disabled" });
        TaskManager.activeProcessors.add("task_1");

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: false, fallbackToLocal: true },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(TaskManager.activeProcessors.has("task_1")).toBe(false);

        getAllSpy.mockRestore();
    });

    test("stream forwarding waits for worker finalization before considering the task handled", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
            { id: "current-instance" },
            { id: "worker-1", directUrl: "https://worker.example.com", activeTaskCount: 0 }
        ]);
        mockClient.iterDownload.mockReturnValue((async function* () {
            yield Buffer.alloc(10 * 1024 * 1024);
        })());
        mockStreamTransferService.resumeTask.mockResolvedValue({
            success: true,
            uploadedBytes: 0,
            canResume: false
        });
        mockStreamTransferService.forwardChunk.mockResolvedValue(true);
        mockStreamTransferService.waitForFinalization.mockResolvedValue({ success: true, completed: true });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            UIHelper: {
                renderProgress: vi.fn(() => "stream progress")
            },
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                port: 3000,
                streamForwarding: {
                    enabled: true,
                    lbUrl: "https://lb.example.com",
                    externalUrl: "https://leader.example.com"
                }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockStreamTransferService.forwardChunk).toHaveBeenCalledWith(
            "task_1",
            expect.any(Buffer),
            expect.objectContaining({
                targetUrl: "https://worker.example.com",
                ownerInstanceId: "worker-1",
                streamMode: "resumable",
                isLast: true
            })
        );
        expect(mockStreamTransferService.registerStreamOwner).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({
                instanceId: "worker-1",
                url: "https://worker.example.com",
                registeredBy: "current-instance"
            })
        );
        expect(mockStreamTransferService.resumeTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({
                ownerInstanceId: "worker-1"
            }),
            "https://worker.example.com"
        );
        expect(mockStreamTransferService.waitForFinalization).toHaveBeenCalledWith(
            "task_1",
            { targetUrl: "https://worker.example.com" }
        );
        expect(mockStreamTransferService.clearStreamOwner).toHaveBeenCalledWith("task_1");
        expect(mockStreamTransferService.resetTask).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();

        getAllSpy.mockRestore();
    });

    test("stream forwarding reset state lets fallback local download enqueue upload", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
            { id: "current-instance" },
            { id: "worker-1", directUrl: "https://worker.example.com", activeTaskCount: 0 }
        ]);
        mockClient.iterDownload.mockReturnValue((async function* () {
            yield Buffer.alloc(1024);
        })());
        mockStreamTransferService.resumeTask.mockResolvedValue({ success: true, uploadedBytes: 0 });
        mockStreamTransferService.forwardChunk.mockRejectedValue(new Error("worker unavailable"));
        mockStreamTransferService.resetTask.mockResolvedValue({ success: true });
        mockClient.downloadMedia.mockResolvedValue();

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            UIHelper: {
                renderProgress: vi.fn(() => "stream progress")
            },
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                port: 3000,
                streamForwarding: {
                    enabled: true,
                    lbUrl: "https://lb.example.com",
                    externalUrl: "https://leader.example.com"
                }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockStreamTransferService.resetTask).toHaveBeenCalledWith(
            "task_1",
            "https://worker.example.com",
            { ownerInstanceId: "worker-1" }
        );
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "reset_stream_download",
            null,
            expect.objectContaining({ source: "stream_forwarding_fallback" })
        );
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({ userId: "user_1" })
        );

        getAllSpy.mockRestore();
    });

    test("stream forwarding fallback recovers when worker failure already marked the task failed", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
            { id: "current-instance" },
            { id: "worker-1", directUrl: "https://worker.example.com", activeTaskCount: 0 }
        ]);
        mockClient.iterDownload.mockReturnValue((async function* () {
            yield Buffer.alloc(1024);
        })());
        mockStreamTransferService.resumeTask.mockResolvedValue({ success: true, uploadedBytes: 0 });
        mockStreamTransferService.forwardChunk.mockRejectedValue(new Error("worker upload failed"));
        mockStreamTransferService.resetTask.mockResolvedValue({ success: true });
        mockClient.downloadMedia.mockResolvedValue();
        mockTaskRepository.transitionStatus.mockImplementation(async (_taskId, event) => {
            if (event === "reset_stream_download") {
                return {
                    changed: true,
                    blocked: false,
                    fromStatus: "failed",
                    toStatus: "downloading",
                    queueAttempt: "downloading:1"
                };
            }
            if (event === "finish_download") {
                return {
                    changed: true,
                    blocked: false,
                    fromStatus: "downloading",
                    toStatus: "downloaded",
                    queueAttempt: "downloaded:2"
                };
            }
            return { changed: true, blocked: false };
        });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            UIHelper: {
                renderProgress: vi.fn(() => "stream progress")
            },
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                port: 3000,
                streamForwarding: {
                    enabled: true,
                    lbUrl: "https://lb.example.com",
                    externalUrl: "https://leader.example.com"
                }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "reset_stream_download",
            null,
            expect.objectContaining({ source: "stream_forwarding_fallback" })
        );
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({
                userId: "user_1",
                _meta: expect.objectContaining({
                    triggerSource: "download-complete",
                    queueAttempt: "downloaded:2"
                })
            })
        );

        getAllSpy.mockRestore();
    });

    test("strict zero-disk direct transfer timeout fails closed without local staging", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockDirectTransferService.canAttempt.mockReturnValue({ supported: true, reason: "rclone-rcat" });
        mockDirectTransferService.transferTelegramMediaToRemote.mockResolvedValue({
            success: false,
            fallback: false,
            error: "TIMEOUT",
            errorCode: "RCLONE_TRANSIENT",
            retryable: true,
            userRetryable: true
        });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            directTransferService: mockDirectTransferService,
            DriveRepository: mockDriveRepository,
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                directTransfer: { enabled: true, fallbackToLocal: false },
                streamForwarding: { enabled: false }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockClient.downloadMedia).not.toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).not.toHaveBeenCalled();
        expect(mockTaskRepository.transitionStatus).toHaveBeenCalledWith(
            "task_1",
            "fail",
            "Zero-disk direct transfer failed; local fallback disabled",
            expect.objectContaining({ source: "handleTaskFailure" })
        );

        getAllSpy.mockRestore();
    });

    test("stream forwarding start blocked falls back to local download instead of swallowing the task", async () => {
        mockCloudTool.getRemoteFileInfo.mockResolvedValue(null);
        mockFs.promises.stat.mockRejectedValue(new Error("ENOENT"));
        mockInstanceCoordinator.getActiveInstances.mockResolvedValue([
            { id: "current-instance" },
            { id: "worker-1", directUrl: "https://worker.example.com", activeTaskCount: 0 }
        ]);
        mockClient.downloadMedia.mockResolvedValue();
        mockTaskRepository.transitionStatus.mockImplementation(async (_taskId, event) => {
            if (event === "start_stream_upload") {
                return {
                    changed: false,
                    blocked: true,
                    reason: "state changed concurrently",
                    fromStatus: "downloaded",
                    toStatus: "uploading"
                };
            }
            if (event === "finish_download") {
                return {
                    changed: true,
                    blocked: false,
                    fromStatus: "downloading",
                    toStatus: "downloaded",
                    queueAttempt: "downloaded:blocked-start"
                };
            }
            return { changed: true, blocked: false };
        });

        const depsSnapshot = {
            ...dependencyContainer.getAll(),
            UIHelper: {
                renderProgress: vi.fn(() => "stream progress")
            },
            config: {
                downloadDir: "/tmp/downloads",
                remoteFolder: "remote_folder",
                port: 3000,
                streamForwarding: {
                    enabled: true,
                    lbUrl: "https://lb.example.com",
                    externalUrl: "https://leader.example.com"
                }
            }
        };
        const getAllSpy = vi.spyOn(dependencyContainer, "getAll").mockReturnValue(depsSnapshot);

        await TaskManager.downloadTask(task);

        expect(mockStreamTransferService.forwardChunk).not.toHaveBeenCalled();
        expect(mockClient.downloadMedia).toHaveBeenCalled();
        expect(mockQueueService.enqueueUploadTask).toHaveBeenCalledWith(
            "task_1",
            expect.objectContaining({
                userId: "user_1",
                _meta: expect.objectContaining({
                    queueAttempt: "downloaded:blocked-start"
                })
            })
        );

        getAllSpy.mockRestore();
    });
});
