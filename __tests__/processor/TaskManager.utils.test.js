import { describe, expect, test, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAll: vi.fn(),
    transitionStatus: vi.fn()
}));

vi.mock("../../src/services/DependencyContainer.js", () => ({
    dependencyContainer: {
        getAll: mocks.getAll
    }
}));

import { handleTaskFailure, handleUploadFailure } from "../../src/processor/TaskManager/TaskManager.utils.js";

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
