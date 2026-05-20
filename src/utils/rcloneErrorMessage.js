import { classifyRcloneError, RCLONE_ERROR_CODES } from "../domain/rclone-error.js";
import { STRINGS } from "../locales/zh-CN.js";

export function getRcloneErrorUserMessage(errorCode) {
    const messages = {
        [RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID]: STRINGS.task.upload_error_drive_auth_invalid,
        [RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID]: STRINGS.task.upload_error_drive_config_invalid,
        [RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND]: STRINGS.task.upload_error_drive_remote_not_found,
        [RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED]: STRINGS.task.upload_error_drive_quota_exceeded,
        [RCLONE_ERROR_CODES.DRIVE_PERMISSION_DENIED]: STRINGS.task.upload_error_drive_permission_denied,
        [RCLONE_ERROR_CODES.RCLONE_TRANSIENT]: STRINGS.task.upload_error_transient
    };

    return messages[errorCode] || null;
}

export function resolveRcloneFailureMetadata(failure = {}, options = {}) {
    const message = failure?.diagnosticMessage || failure?.error || failure?.message || "";
    const classification = classifyRcloneError(message, options);
    const hasDerivedCode = classification.code !== RCLONE_ERROR_CODES.UNKNOWN;
    const errorCode = hasDerivedCode
        ? classification.code
        : (failure?.errorCode || classification.code);
    const mappedUserMessage = getRcloneErrorUserMessage(errorCode);
    const userMessage = hasDerivedCode
        ? mappedUserMessage
        : (failure?.userMessage || mappedUserMessage || null);

    return {
        errorCode,
        userMessage,
        retryable: hasDerivedCode
            ? classification.retryable
            : (typeof failure?.retryable === "boolean" ? failure.retryable : classification.retryable),
        userRetryable: hasDerivedCode
            ? classification.userRetryable
            : (typeof failure?.userRetryable === "boolean" ? failure.userRetryable : classification.userRetryable)
    };
}
