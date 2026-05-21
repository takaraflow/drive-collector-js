export const RCLONE_ERROR_CODES = Object.freeze({
    DRIVE_AUTH_INVALID: "DRIVE_AUTH_INVALID",
    DRIVE_CONFIG_INVALID: "DRIVE_CONFIG_INVALID",
    DRIVE_REMOTE_NOT_FOUND: "DRIVE_REMOTE_NOT_FOUND",
    DRIVE_QUOTA_EXCEEDED: "DRIVE_QUOTA_EXCEEDED",
    DRIVE_PERMISSION_DENIED: "DRIVE_PERMISSION_DENIED",
    RCLONE_TRANSIENT: "RCLONE_TRANSIENT",
    UNKNOWN: "UNKNOWN"
});

const TRANSIENT_ERROR_PATTERNS = [
    /^TIMEOUT$/i,
    /temporary failure/i,
    /connection (reset|refused|aborted|closed)/i,
    /i\/o timeout/i,
    /rclone [\s\S]* timed out/i,
    /rclone [\s\S]* exited with code null/i,
    /rclone [\s\S]* terminated by signal/i,
    /rclone [\s\S]* exited without an exit code/i,
    /TLS handshake timeout/i,
    /timeout awaiting response headers/i,
    /server closed idle connection/i,
    /unexpected EOF/i,
    /EOF while (reading|waiting|connecting)/i
];

const AUTH_ERROR_PATTERNS = [
    /couldn'?t login/i,
    /authentication failed/i,
    /invalid (?:login|credentials|username|password)/i,
    /bad password/i,
    /login failed/i,
    /unauthorized/i,
    /invalid[_ -]?grant/i,
    /token (?:expired|invalid|revoked)/i
];

const QUOTA_ERROR_PATTERNS = [
    /quota exceeded/i,
    /insufficient (?:storage|space)/i,
    /not enough (?:storage|space)/i,
    /storage .*full/i,
    /disk full/i
];

const PERMISSION_ERROR_PATTERNS = [
    /permission denied/i,
    /access denied/i,
    /forbidden/i,
    /\b403\b/
];

const MEGA_LOGIN_OBJECT_NOT_FOUND = /couldn'?t login[\s\S]*Object \(typically, node or user\) not found/i;
const REMOTE_NOT_FOUND_PATTERNS = [
    /Object \(typically, node or user\) not found/i,
    /directory not found/i,
    /object not found/i,
    /node not found/i
];
const CONFIG_INVALID_PATTERNS = [
    /missing required drive config/i,
    /missing required .* config/i,
    /invalid drive config/i
];
const TRANSIENT_JSON_STARTUP_ERROR = /unexpected end of JSON input/i;
const TRANSIENT_JSON_CONTEXT = /(failed to create file system|couldn'?t login|remote API|server response|mega)/i;
const hasAnyMatch = (text, patterns) => patterns.some(pattern => pattern.test(text));
const hasMegaRemotePath = (text) => /:mega,[\s\S]*?:(?!["\\\s])/i.test(text);
const isPathScopedOperation = (options = {}) => (
    options.remotePathScoped === true
);

export function classifyRcloneError(errorText, options = {}) {
    const text = String(errorText || "").trim();
    if (!text) {
        return {
            code: RCLONE_ERROR_CODES.UNKNOWN,
            retryable: false,
            userRetryable: true
        };
    }

    if (MEGA_LOGIN_OBJECT_NOT_FOUND.test(text)) {
        const remotePathScoped = isPathScopedOperation(options) || hasMegaRemotePath(text);
        return {
            code: remotePathScoped ? RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND : RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            retryable: false,
            userRetryable: remotePathScoped
        };
    }

    if (hasAnyMatch(text, CONFIG_INVALID_PATTERNS)) {
        return {
            code: RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID,
            retryable: false,
            userRetryable: true
        };
    }

    if (hasAnyMatch(text, REMOTE_NOT_FOUND_PATTERNS)) {
        return {
            code: RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND,
            retryable: false,
            userRetryable: true
        };
    }

    if (TRANSIENT_JSON_STARTUP_ERROR.test(text) && TRANSIENT_JSON_CONTEXT.test(text)) {
        return {
            code: RCLONE_ERROR_CODES.RCLONE_TRANSIENT,
            retryable: true,
            userRetryable: true
        };
    }

    if (hasAnyMatch(text, AUTH_ERROR_PATTERNS)) {
        return {
            code: RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
            retryable: false,
            userRetryable: false
        };
    }

    if (hasAnyMatch(text, QUOTA_ERROR_PATTERNS)) {
        return {
            code: RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
            retryable: false,
            userRetryable: true
        };
    }

    if (hasAnyMatch(text, PERMISSION_ERROR_PATTERNS)) {
        return {
            code: RCLONE_ERROR_CODES.DRIVE_PERMISSION_DENIED,
            retryable: false,
            userRetryable: false
        };
    }

    if (hasAnyMatch(text, TRANSIENT_ERROR_PATTERNS)) {
        return {
            code: RCLONE_ERROR_CODES.RCLONE_TRANSIENT,
            retryable: true,
            userRetryable: true
        };
    }

    return {
        code: RCLONE_ERROR_CODES.UNKNOWN,
        retryable: false,
        userRetryable: true
    };
}

export function isRetryableRcloneError(errorText, options = {}) {
    return classifyRcloneError(errorText, options).retryable === true;
}
