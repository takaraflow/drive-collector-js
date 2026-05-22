import { describe, expect, test, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAll: vi.fn(),
    transitionStatus: vi.fn(),
    recordTaskProgress: vi.fn(),
    refreshActiveTaskLiveness: vi.fn()
}));

vi.mock("../../src/services/DependencyContainer.js", () => ({
    dependencyContainer: {
        getAll: mocks.getAll
    }
}));

import { createHeartbeat, handleTaskFailure, handleUploadFailure } from "../../src/processor/TaskManager/TaskManager.utils.js";

const format = (template, values = {}) => Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
    template
);

describe("TaskManager upload failure handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.transitionStatus.mockResolvedValue({ changed: true, blocked: false, toStatus: "failed" });
        mocks.getAll.mockReturnValue({
            TaskRepository: {
                transitionStatus: mocks.transitionStatus
            },
            STRINGS: {
                task: {
                    cancelled: "cancelled",
                    error_prefix: "error: ",
                    failed_action_required: "action required {{reason}}",
                    failed_upload: "failed upload {{reason}}",
                    failed_upload_action_required: "action required {{reason}}"
                }
            },
            format
        });
    });

    test("shows remote folder guidance without raw rclone diagnostics", async () => {
        const updateStatus = vi.fn();
        const rawError = `CRITICAL | Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":folder": couldn't login: Object (typically, node or user) not found`;

        await handleUploadFailure(
            { id: "task-1", isGroup: false },
            {},
            updateStatus,
            {
                success: false,
                error: rawError,
                errorCode: "DRIVE_REMOTE_NOT_FOUND",
                userMessage: "目标网盘保存目录或远端节点不可用。请检查保存目录，或重新选择/重置保存目录后再重试。",
                userRetryable: true
            }
        );

        expect(mocks.transitionStatus).toHaveBeenCalledWith(
            "task-1",
            "fail",
            expect.stringContaining('user="[REDACTED]"'),
            expect.objectContaining({ source: "handleUploadFailure" })
        );
        expect(mocks.transitionStatus.mock.calls[0][2]).not.toContain("user@example.com");
        expect(mocks.transitionStatus.mock.calls[0][2]).not.toContain("secret-pass");

        expect(updateStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: "task-1" }),
            "action required 目标网盘保存目录或远端节点不可用。请检查保存目录，或重新选择/重置保存目录后再重试。",
            true,
            null,
            true
        );
        expect(updateStatus.mock.calls[0][1]).not.toContain("Object (typically, node or user) not found");
        expect(updateStatus.mock.calls[0][1]).not.toContain("Rclone");
    });

    test("maps raw rclone task failures to remote folder guidance", async () => {
        const updateStatus = vi.fn();
        const rawError = `Download failed: CRITICAL | Failed to create file system for ":mega,user="[REDACTED]":folder": couldn't login: Object (typically, node or user) not found`;

        await handleTaskFailure(
            { id: "task-2", isGroup: false },
            {},
            updateStatus,
            rawError,
            false
        );

        expect(mocks.transitionStatus).toHaveBeenCalledWith(
            "task-2",
            "fail",
            rawError,
            expect.objectContaining({ source: "handleTaskFailure" })
        );
        expect(updateStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: "task-2" }),
            "action required 目标网盘保存目录或远端节点不可用。请检查保存目录，或重新选择/重置保存目录后再重试。",
            true,
            null,
            true
        );
        expect(updateStatus.mock.calls[0][1]).not.toContain("Object (typically, node or user) not found");
    });

    test("prefers current rclone diagnostics over stale failure metadata", async () => {
        const updateStatus = vi.fn();
        const rawError = `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`;

        await handleTaskFailure(
            { id: "task-stale-code", isGroup: false },
            {},
            updateStatus,
            {
                error: rawError,
                errorCode: "DRIVE_AUTH_INVALID",
                userMessage: "当前绑定的网盘无法登录。请重新绑定网盘后再重试。",
                userRetryable: false
            },
            false
        );

        expect(updateStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: "task-stale-code" }),
            "action required 目标网盘保存目录或远端节点不可用。请检查保存目录，或重新选择/重置保存目录后再重试。",
            true,
            null,
            true
        );
    });

    test("does not expose retryable queue infrastructure diagnostics to users", async () => {
        const updateStatus = vi.fn();

        await handleTaskFailure(
            { id: "task-queue", isGroup: false },
            {},
            updateStatus,
            new Error("Circuit breaker is OPEN for qstash_publish"),
            false
        );

        expect(mocks.transitionStatus).toHaveBeenCalledWith(
            "task-queue",
            "fail",
            "Circuit breaker is OPEN for qstash_publish",
            expect.objectContaining({ source: "handleTaskFailure" })
        );
        expect(updateStatus).toHaveBeenCalledWith(
            expect.objectContaining({ id: "task-queue" }),
            "action required 系统队列暂时繁忙，请稍后重试或查看状态。",
            true,
            null,
            true
        );
        expect(updateStatus.mock.calls[0][1]).not.toContain("qstash_publish");
    });
});

describe("TaskManager heartbeat handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(1700000000000);
        mocks.transitionStatus.mockResolvedValue({ changed: true, blocked: false, toStatus: "uploading" });
        mocks.recordTaskProgress.mockResolvedValue(true);
        mocks.refreshActiveTaskLiveness.mockResolvedValue({ changed: true, blocked: false, toStatus: "uploading" });
        mocks.getAll.mockReturnValue({
            TaskRepository: {
                transitionStatus: mocks.transitionStatus,
                recordTaskProgress: mocks.recordTaskProgress,
                refreshActiveTaskLiveness: mocks.refreshActiveTaskLiveness
            },
            STRINGS: {
                task: {
                    uploading: "uploading",
                    downloading: "downloading"
                }
            },
            UIHelper: {
                renderProgress: vi.fn(() => "progress")
            },
            format
        });
    });

    test("keeps high-frequency heartbeat progress in Redis while throttling D1 and UI", async () => {
        const updateStatus = vi.fn();
        const heartbeat = createHeartbeat(
            { id: "task-heartbeat", isGroup: false },
            { cancelledTaskIds: new Set() },
            updateStatus,
            "file.bin"
        );

        await heartbeat("uploading", 0, 0, { bytes: 1024, size: 4096 });
        vi.setSystemTime(1700000001000);
        await heartbeat("uploading", 0, 0, { bytes: 2048, size: 4096 });
        vi.setSystemTime(1700000003000);
        await heartbeat("uploading", 0, 0, { bytes: 3072, size: 4096 });

        expect(mocks.recordTaskProgress).toHaveBeenCalledTimes(3);
        expect(mocks.recordTaskProgress).toHaveBeenLastCalledWith(
            "task-heartbeat",
            "uploading",
            expect.objectContaining({ transferred: 3072, total: 4096, fileName: "file.bin" }),
            expect.objectContaining({ fileName: "file.bin" })
        );
        expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
        expect(mocks.refreshActiveTaskLiveness).not.toHaveBeenCalled();
        expect(updateStatus).toHaveBeenCalledTimes(2);
    });

    test("refreshes canonical liveness after the heartbeat interval", async () => {
        const updateStatus = vi.fn();
        const heartbeat = createHeartbeat(
            { id: "task-heartbeat-liveness", isGroup: false },
            { cancelledTaskIds: new Set() },
            updateStatus,
            "file.bin"
        );

        await heartbeat("downloading", 1024, 4096);
        vi.setSystemTime(1700000060000);
        await heartbeat("downloading", 2048, 4096);

        expect(mocks.recordTaskProgress).toHaveBeenCalledTimes(2);
        expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
        expect(mocks.transitionStatus).toHaveBeenCalledWith(
            "task-heartbeat-liveness",
            "start_download",
            null,
            expect.objectContaining({ source: "heartbeat" })
        );
        expect(mocks.refreshActiveTaskLiveness).toHaveBeenCalledWith(
            "task-heartbeat-liveness",
            "downloading",
            expect.objectContaining({ source: "heartbeat_liveness" })
        );
    });

    test("does not throttle final heartbeat progress", async () => {
        const updateStatus = vi.fn();
        const heartbeat = createHeartbeat(
            { id: "task-heartbeat-final", isGroup: false },
            { cancelledTaskIds: new Set() },
            updateStatus,
            "file.bin"
        );

        await heartbeat("uploading", 0, 0, { bytes: 1024, size: 4096 });
        vi.setSystemTime(1700000001000);
        await heartbeat("uploading", 0, 0, { bytes: 4096, size: 4096 });

        expect(mocks.recordTaskProgress).toHaveBeenCalledTimes(2);
        expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
        expect(mocks.refreshActiveTaskLiveness).toHaveBeenCalledTimes(1);
        expect(updateStatus).toHaveBeenCalledTimes(2);
    });

    test("does not write derived progress when canonical heartbeat is blocked", async () => {
        mocks.transitionStatus.mockResolvedValueOnce({
            changed: false,
            blocked: true,
            reason: "Task status changed concurrently"
        });
        const updateStatus = vi.fn();
        const heartbeat = createHeartbeat(
            { id: "task-heartbeat-blocked", isGroup: false },
            { cancelledTaskIds: new Set() },
            updateStatus,
            "file.bin"
        );

        await heartbeat("uploading", 0, 0, { bytes: 1024, size: 4096 });

        expect(mocks.recordTaskProgress).not.toHaveBeenCalled();
        expect(updateStatus).not.toHaveBeenCalled();
    });
});
