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
