import { describe, expect, test } from "vitest";
import { RCLONE_ERROR_CODES } from "../../../src/domain/rclone-error.js";
import { resolveRcloneFailureMetadata } from "../../../src/utils/rcloneErrorMessage.js";

describe("rclone failure metadata resolution", () => {
    test("prefers current diagnostics over stale metadata", () => {
        const result = resolveRcloneFailureMetadata({
            error: `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`,
            errorCode: RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            userMessage: "当前绑定的网盘无法登录。请重新绑定网盘后再重试。",
            retryable: false,
            userRetryable: false
        }, {
            operation: "copyto",
            remotePathScoped: true
        });

        expect(result).toMatchObject({
            errorCode: RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND,
            retryable: false,
            userRetryable: true
        });
        expect(result.userMessage).toContain("保存目录");
        expect(result.userMessage).not.toContain("无法登录");
    });

    test("keeps explicit metadata when diagnostics are not conclusive", () => {
        const result = resolveRcloneFailureMetadata({
            error: "rclone failed",
            errorCode: RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            userMessage: "custom user message",
            retryable: false,
            userRetryable: false
        }, {
            operation: "copyto",
            remotePathScoped: true
        });

        expect(result).toMatchObject({
            errorCode: RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            userMessage: "custom user message",
            retryable: false,
            userRetryable: false
        });
    });
});
