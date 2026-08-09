import { describe, expect, test } from "vitest";
import { classifyRcloneError, isRetryableRcloneError, RCLONE_ERROR_CODES } from "../../../src/domain/rclone-error.js";

describe("rclone error classification", () => {
    test("classifies root MEGA object-not-found as invalid drive auth", () => {
        const error = `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`;

        const result = classifyRcloneError(error);

        expect(result).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            retryable: false,
            userRetryable: false
        });
        expect(isRetryableRcloneError(error)).toBe(false);
    });

    test("classifies path-scoped MEGA object-not-found as remote configuration guidance", () => {
        const error = `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]\\":folder/file": couldn't login: Object (typically, node or user) not found`;

        const result = classifyRcloneError(error);

        expect(result).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND,
            retryable: false,
            userRetryable: true
        });
    });

    test("uses remote path context when sanitized diagnostics lose path context", () => {
        const error = `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`;

        expect(classifyRcloneError(error, { remotePathScoped: true })).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND,
            retryable: false,
            userRetryable: true
        });
    });

    test("classifies missing provider config without calling it auth", () => {
        const error = "Missing required drive config for mega: pass";

        expect(classifyRcloneError(error)).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID,
            retryable: false,
            userRetryable: true
        });
    });

    test("classifies Proton invalid token and 2FA refresh failures as invalid auth", () => {
        const error = `2026/08/09 14:14:20 NOTICE: proton drive root link ID 'DriveCollectorBot': 401 GET https://drive-api.proton.me/core/v4/users: Invalid access token (Code=401, Status=401), Attempt 1
2026/08/09 14:14:21 NOTICE: proton drive root link ID 'DriveCollectorBot': 400 POST https://drive-api.proton.me/auth/v4/refresh: Invalid refresh token (Code=10013, Status=400), Attempt 1
2026/08/09 14:14:25 CRITICAL: Failed to create file system for "u7428626313:DriveCollectorBot": couldn't initialize a new proton drive instance: this account requires a 2FA code. Can be provided with --protondrive-2fa=000000`;

        expect(classifyRcloneError(error)).toMatchObject({
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

    test("classifies bare timeout diagnostics as retryable transient failures", () => {
        expect(classifyRcloneError("TIMEOUT")).toMatchObject({
            code: RCLONE_ERROR_CODES.RCLONE_TRANSIENT,
            retryable: true,
            userRetryable: true
        });
        expect(isRetryableRcloneError("TIMEOUT")).toBe(true);
    });

    test("classifies rclone process exits without a code as retryable transient failures", () => {
        for (const message of [
            "rclone rcat exited with code null",
            "rclone rcat exited without an exit code",
            "rclone rcat terminated by signal SIGTERM"
        ]) {
            expect(classifyRcloneError(message)).toMatchObject({
                code: RCLONE_ERROR_CODES.RCLONE_TRANSIENT,
                retryable: true,
                userRetryable: true
            });
            expect(isRetryableRcloneError(message)).toBe(true);
        }
    });

    test("classifies quota and permission errors as user-actionable failures", () => {
        expect(classifyRcloneError("Failed to copy: quota exceeded")).toMatchObject({
            code: RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
            retryable: false,
            userRetryable: true
        });
        expect(classifyRcloneError("upload file failed to create session: [REDACTED] over quota")).toMatchObject({
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
