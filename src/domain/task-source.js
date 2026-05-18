export const TASK_SOURCE_TYPES = Object.freeze({
    TELEGRAM_MEDIA: "telegram_media",
    EXTERNAL_URL: "external_url"
});

const KNOWN_SOURCE_TYPES = new Set(Object.values(TASK_SOURCE_TYPES));

export function normalizeTaskSourceType(sourceType) {
    if (!sourceType) return TASK_SOURCE_TYPES.TELEGRAM_MEDIA;
    const normalized = String(sourceType).trim();
    if (!KNOWN_SOURCE_TYPES.has(normalized)) {
        throw new Error(`Unsupported task source type: ${normalized}`);
    }
    return normalized;
}

export function isExternalUrlTask(rowOrTask = {}) {
    return normalizeTaskSourceType(rowOrTask.source_type || rowOrTask.sourceType) === TASK_SOURCE_TYPES.EXTERNAL_URL;
}

export function serializeTaskSourceRef(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
}

export function parseTaskSourceRef(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return { raw: String(value) };
    }
}

export function buildTelegramMediaSourceRef({ chatId, messageId } = {}) {
    return {
        chatId: chatId == null ? null : String(chatId),
        messageId: messageId == null ? null : Number(messageId)
    };
}

export function buildExternalUrlSourceRef(source = {}) {
    const retained = source.retained || source.retainedSourceRef || null;
    return {
        url: source.url,
        finalUrl: source.finalUrl || source.url,
        displayUrl: source.displayUrl || null,
        fingerprint: source.fingerprint || null,
        retained,
        fileName: source.fileName || "download.bin",
        fileSize: Number.isFinite(source.fileSize) ? source.fileSize : 0,
        contentType: source.contentType || null,
        probedAt: source.probedAt || Date.now()
    };
}
