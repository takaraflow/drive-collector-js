export const INFRASTRUCTURE_ERROR_CODES = Object.freeze({
    QUEUE_CIRCUIT_OPEN: "QUEUE_CIRCUIT_OPEN",
    QUEUE_UNAVAILABLE: "QUEUE_UNAVAILABLE",
    LOCK_BUSY: "LOCK_BUSY",
    CACHE_UNAVAILABLE: "CACHE_UNAVAILABLE",
    NETWORK_TRANSIENT: "NETWORK_TRANSIENT",
    DATABASE_TRANSIENT: "DATABASE_TRANSIENT",
    UNKNOWN: "UNKNOWN"
});

const QUEUE_CIRCUIT_OPEN_PATTERNS = [
    /Circuit breaker is OPEN/i,
    /circuit breaker.*open/i
];

const QUEUE_ERROR_PATTERNS = [
    /qstash/i,
    /queue enqueue failed/i,
    /durable queue publish/i,
    /publishJSON/i,
    /publish failed/i
];

const LOCK_ERROR_PATTERNS = [
    /task processing lock busy/i,
    /lock acquisition failed/i
];

const CACHE_ERROR_PATTERNS = [
    /\bcache\b/i,
    /\bredis\b/i,
    /\bvalkey\b/i,
    /\bupstash\b/i,
    /\bkv\b/i
];

const NETWORK_ERROR_PATTERNS = [
    /timeout/i,
    /ETIMEDOUT/i,
    /fetch failed/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ENOTFOUND/i,
    /getaddrinfo/i,
    /network connection lost/i,
    /CONNECTION_NOT_INITED/i,
    /Cannot send requests while disconnected/i,
    /Not connected/i,
    /Connection closed/i,
    /Client not initialized/i,
    /upload\.GetFile/i,
    /Cannot read propert(?:y|ies) of undefined \(reading ['"]dcId['"]\)/i,
    /rate limit/i,
    /\b429\b/
];

const DATABASE_TRANSIENT_PATTERNS = [
    /D1 HTTP 5\d\d/i,
    /D1 HTTP 400 \[7500\]/i,
    /D1 Error: Network connection lost/i,
    /database network/i
];

const hasAnyMatch = (text, patterns) => patterns.some(pattern => pattern.test(text));

function normalizeErrorText(error) {
    if (error === null || error === undefined) return "";
    if (typeof error === "string") return error;
    return [
        error.name,
        error.code,
        error.message,
        error.cause?.message
    ].filter(Boolean).join(" ");
}

export function classifyInfrastructureError(error) {
    const text = normalizeErrorText(error);
    const code = error?.code || "";

    if (!text && !code) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.UNKNOWN,
            retryable: false
        };
    }

    if (hasAnyMatch(text, QUEUE_CIRCUIT_OPEN_PATTERNS)) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.QUEUE_CIRCUIT_OPEN,
            retryable: true,
            retryScope: "queue"
        };
    }

    if (hasAnyMatch(text, QUEUE_ERROR_PATTERNS)) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.QUEUE_UNAVAILABLE,
            retryable: true,
            retryScope: "queue"
        };
    }

    if (code === "TASK_PROCESSING_LOCK_BUSY" || hasAnyMatch(text, LOCK_ERROR_PATTERNS)) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.LOCK_BUSY,
            retryable: true,
            retryScope: "lock"
        };
    }

    if (hasAnyMatch(text, DATABASE_TRANSIENT_PATTERNS)) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.DATABASE_TRANSIENT,
            retryable: true,
            retryScope: "database"
        };
    }

    if (hasAnyMatch(text, CACHE_ERROR_PATTERNS)) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.CACHE_UNAVAILABLE,
            retryable: true,
            retryScope: "cache"
        };
    }

    if (hasAnyMatch(text, NETWORK_ERROR_PATTERNS)) {
        return {
            code: INFRASTRUCTURE_ERROR_CODES.NETWORK_TRANSIENT,
            retryable: true,
            retryScope: "network"
        };
    }

    return {
        code: INFRASTRUCTURE_ERROR_CODES.UNKNOWN,
        retryable: false
    };
}

export function isRetryableInfrastructureError(error) {
    return classifyInfrastructureError(error).retryable === true;
}
