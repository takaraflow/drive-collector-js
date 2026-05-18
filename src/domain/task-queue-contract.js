import crypto from "crypto";

export const TASK_QUEUE_TYPES = Object.freeze({
    DOWNLOAD: "download",
    UPLOAD: "upload"
});

export const TASK_QUEUE_TRIGGER_SOURCES = Object.freeze({
    QSTASH: "qstash-v2",
    DIRECT_QSTASH: "direct-qstash",
    MANUAL_RETRY: "manual-retry",
    DOWNLOAD_COMPLETE: "download-complete",
    LOCAL_FILE_READY: "local-file-ready"
});

export const TASK_QUEUE_DEFAULT_ATTEMPT = "initial";

export function normalizeTaskQueueAttempt(queueAttempt) {
    if (queueAttempt === null || queueAttempt === undefined) return TASK_QUEUE_DEFAULT_ATTEMPT;
    const normalized = String(queueAttempt).trim();
    return normalized || TASK_QUEUE_DEFAULT_ATTEMPT;
}

function buildIdempotencySource(topic, type, taskId, queueAttempt) {
    return JSON.stringify([
        String(topic || ""),
        String(type || ""),
        String(taskId || ""),
        normalizeTaskQueueAttempt(queueAttempt)
    ]);
}

function safeIdLabel(value) {
    const label = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    return (label || "x").slice(0, 24);
}

export function buildTaskQueueIdempotencyKey(topic, type, taskId, queueAttempt = TASK_QUEUE_DEFAULT_ATTEMPT) {
    const source = buildIdempotencySource(topic, type, taskId, queueAttempt);
    const digest = crypto.createHash("sha256").update(source).digest("base64url");
    return `tqv1_${safeIdLabel(topic)}_${safeIdLabel(type)}_${digest}`;
}

export class TaskProcessingLockBusyError extends Error {
    constructor(taskId, phase) {
        super(`Task processing lock busy for ${phase} task ${taskId}`);
        this.name = "TaskProcessingLockBusyError";
        this.code = "TASK_PROCESSING_LOCK_BUSY";
        this.taskId = taskId;
        this.phase = phase;
    }
}

export function isTaskProcessingLockBusyError(error) {
    return error?.code === "TASK_PROCESSING_LOCK_BUSY" || error?.name === "TaskProcessingLockBusyError";
}

export function buildTaskQueueMeta(meta = {}, runtime = {}) {
    const existingMeta = meta && typeof meta === "object" ? meta : {};
    return {
        triggerSource: runtime.triggerSource || TASK_QUEUE_TRIGGER_SOURCES.QSTASH,
        instanceId: runtime.instanceId || "unknown",
        timestamp: runtime.timestamp || Date.now(),
        ...existingMeta
    };
}

export function buildTaskQueueMessage(type, taskId, data = {}, runtime = {}) {
    const { _meta, ...rest } = data || {};
    return {
        taskId,
        type,
        ...rest,
        _meta: buildTaskQueueMeta(_meta, runtime)
    };
}

export function buildDownloadQueueMessage(taskId, data = {}, runtime = {}) {
    return buildTaskQueueMessage(TASK_QUEUE_TYPES.DOWNLOAD, taskId, data, runtime);
}

export function buildUploadQueueMessage(taskId, data = {}, runtime = {}) {
    return buildTaskQueueMessage(TASK_QUEUE_TYPES.UPLOAD, taskId, data, runtime);
}

export function parseTaskQueuePayload(payload = {}) {
    const meta = payload && typeof payload._meta === "object" ? payload._meta : {};
    return {
        taskId: payload?.taskId || null,
        type: payload?.type || null,
        groupId: payload?.groupId || meta.groupId || null,
        meta: {
            triggerSource: meta.triggerSource || "unknown",
            instanceId: meta.instanceId || "unknown",
            timestamp: meta.timestamp || Date.now(),
            ...meta
        }
    };
}
