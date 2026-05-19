import { describe, expect, test } from "vitest";
import { classifyRcloneError, isRetryableRcloneError, RCLONE_ERROR_CODES } from "../../../src/domain/rclone-error.js";

describe("rclone error classification", () => {
    test("classifies MEGA login object-not-found as invalid drive auth", () => {
        const error = `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`;

        const result = classifyRcloneError(error);

        expect(result).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            retryable: false,
            userRetryable: false
        });
        expect(isRetryableRcloneError(error)).toBe(false);
    });

    test("keeps transient MEGA startup parse failures retryable", () => {
        const error = `CRITICAL: Failed to create file system for ":mega,user=\\"[REDACTED]\\",pass=\\"[REDACTED]\\":folder": unexpected end of JSON input`;

        expect(classifyRcloneError(error)).toMatchObject({
            code: RCLONE_ERROR_CODES.RCLONE_TRANSIENT,
            retryable: true,
            userRetryable: true
        });
        expect(isRetryableRcloneError(error)).toBe(true);
    });

    test("classifies quota and permission errors as user-actionable failures", () => {
        expect(classifyRcloneError("Failed to copy: quota exceeded")).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
            retryable: false,
            userRetryable: true
        });
        expect(classifyRcloneError("Failed to copy: permission denied")).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_PERMISSION_DENIED,
            retryable: false,
            userRetryable: false
        });
    });
});
