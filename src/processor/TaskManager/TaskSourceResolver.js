import { dependencyContainer } from "../../services/DependencyContainer.js";
import {
    TASK_SOURCE_TYPES,
    buildTelegramMediaSourceRef,
    isExternalUrlTask,
    normalizeTaskSourceType,
    parseTaskSourceRef
} from "../../domain/task-source.js";
import { TASK_STATUSES } from "../../domain/task-state-machine.js";

export async function resolveTaskSource(dbTask) {
    if (!dbTask) {
        throw new Error("Task source requires a database task.");
    }

    const sourceType = normalizeTaskSourceType(dbTask.source_type);
    if (sourceType === TASK_SOURCE_TYPES.EXTERNAL_URL) {
        return resolveExternalUrlSource(dbTask);
    }

    return await resolveTelegramMediaSource(dbTask);
}

export function resolveStoredTaskSource(dbTask) {
    if (!dbTask) {
        throw new Error("Task source requires a database task.");
    }

    const sourceType = normalizeTaskSourceType(dbTask.source_type);
    if (sourceType === TASK_SOURCE_TYPES.EXTERNAL_URL) {
        return resolveExternalUrlSource(dbTask);
    }

    return resolveStoredTelegramMediaSource(dbTask);
}

export function buildTaskObjectFromDb(dbTask, resolvedSource = {}) {
    const task = {
        id: dbTask.id,
        userId: dbTask.user_id?.toString(),
        chatId: dbTask.chat_id?.toString(),
        msgId: dbTask.msg_id,
        sourceMsgId: dbTask.source_msg_id,
        message: resolvedSource.message || null,
        sourceType: resolvedSource.sourceType,
        sourceRef: resolvedSource.sourceRef || null,
        fileInfo: resolvedSource.fileInfo || null,
        fileName: dbTask.file_name || resolvedSource.fileInfo?.name || "unknown",
        lastText: "",
        isCancelled: false
    };

    if (isExternalUrlTask(task)) {
        task.externalUrl = resolvedSource.sourceRef?.url || null;
    }

    return task;
}

function resolveStoredTelegramMediaSource(dbTask) {
    const storedSourceRef = parseTaskSourceRef(dbTask.source_ref);
    const sourceRef = storedSourceRef || buildTelegramMediaSourceRef({
        chatId: dbTask.chat_id,
        messageId: dbTask.source_msg_id
    });
    const messageId = sourceRef?.messageId || dbTask.source_msg_id;
    if (!messageId) {
        const error = new Error("Source msg missing");
        error.code = "TASK_SOURCE_MISSING";
        throw error;
    }

    return {
        sourceType: TASK_SOURCE_TYPES.TELEGRAM_MEDIA,
        sourceRef,
        fileInfo: {
            name: dbTask.file_name || "unknown",
            size: Number(dbTask.file_size) || 0
        }
    };
}

async function resolveTelegramMediaSource(dbTask) {
    const { client, runMtprotoTaskWithRetry, PRIORITY } = dependencyContainer.getAll();
    const messages = await runMtprotoTaskWithRetry(
        () => client.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
        { priority: PRIORITY.BACKGROUND }
    );
    const message = messages[0];
    if (!message || !message.media) {
        const error = new Error("Source msg missing");
        error.code = "TASK_SOURCE_MISSING";
        throw error;
    }

    return {
        sourceType: TASK_SOURCE_TYPES.TELEGRAM_MEDIA,
        sourceRef: parseTaskSourceRef(dbTask.source_ref),
        message
    };
}

function resolveExternalUrlSource(dbTask) {
    const sourceRef = parseTaskSourceRef(dbTask.source_ref);
    const stillNeedsDownloadSource = [
        TASK_STATUSES.QUEUED,
        TASK_STATUSES.DOWNLOADING
    ].includes(dbTask.status);
    if (!sourceRef || (!sourceRef.url && stillNeedsDownloadSource)) {
        const error = new Error("External URL source missing");
        error.code = "TASK_SOURCE_MISSING";
        throw error;
    }

    return {
        sourceType: TASK_SOURCE_TYPES.EXTERNAL_URL,
        sourceRef,
        fileInfo: {
            name: dbTask.file_name || sourceRef.fileName || "download.bin",
            size: Number.isFinite(Number(dbTask.file_size)) && Number(dbTask.file_size) > 0
                ? Number(dbTask.file_size)
                : Number(sourceRef.fileSize) || 0
        }
    };
}
