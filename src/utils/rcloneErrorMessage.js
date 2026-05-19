import { RCLONE_ERROR_CODES } from "../domain/rclone-error.js";
import { STRINGS } from "../locales/zh-CN.js";

export function getRcloneErrorUserMessage(errorCode) {
    const messages = {
        [RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID]: STRINGS.task.upload_error_drive_auth_invalid,
        [RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED]: STRINGS.task.upload_error_drive_quota_exceeded,
        [RCLONE_ERROR_CODES.DRIVE_PERMISSION_DENIED]: STRINGS.task.upload_error_drive_permission_denied,
        [RCLONE_ERROR_CODES.RCLONE_TRANSIENT]: STRINGS.task.upload_error_transient
    };

    return messages[errorCode] || null;
}
