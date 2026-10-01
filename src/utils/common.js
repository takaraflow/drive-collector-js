import { Button } from "telegram/tl/custom/button.js";
import { runBotTaskWithRetry } from "./limiter.js";
import { STRINGS } from "../locales/zh-CN.js";
import { logger } from "../services/logger/index.js";
import crypto from "crypto";

const log = logger.withModule ? logger.withModule('CommonUtils') : logger;
const messageEditQueues = new Map();
const latestMessageEditIntents = new Map();

const buildEditQueueKey = (chatId, msgId) => `${String(chatId)}:${String(msgId)}`;
const buildEditIntentFingerprint = (text, buttons, parseMode) => JSON.stringify({
    text,
    buttons: buttons ?? null,
    parseMode
});

export const __resetSafeEditStateForTests = () => {
    messageEditQueues.clear();
    latestMessageEditIntents.clear();
};

/**
 * --- 辅助工具函数 (Internal Helpers) ---
 */

/**
 * 转义 HTML 特殊字符，防止消息注入
 */
export const escapeHTML = (str) => {
    if (!str) return "";
    return str
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/"/g, "&" + "quot;")
        .replace(/'/g, "&" + "#039;");
};

// 安全编辑消息，统一处理异常
export const safeEdit = async (chatId, msgId, text, buttons = null, userId = null, parseMode = "html", options = {}) => {
    const queueKey = buildEditQueueKey(chatId, msgId);
    const intendedFingerprint = buildEditIntentFingerprint(text, buttons, parseMode);
    latestMessageEditIntents.set(queueKey, intendedFingerprint);

    const previous = messageEditQueues.get(queueKey) || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(async () => {
            if (latestMessageEditIntents.get(queueKey) !== intendedFingerprint) {
                return true;
            }

            const { client } = await import("../services/telegram.js");
            try {
                const result = await runBotTaskWithRetry(
                    async () => {
                        if (latestMessageEditIntents.get(queueKey) !== intendedFingerprint) {
                            return true;
                        }
                        try {
                            await client.editMessage(chatId, { message: msgId, text, buttons, parseMode });
                        } catch (e) {
                            // 忽略 "Message Not Modified" 错误
                            if (e.message && (e.message.includes("MESSAGE_NOT_MODIFIED") || e.code === 400 && e.errorMessage === "MESSAGE_NOT_MODIFIED")) {
                                return;
                            }
                            // 处理 AUTH_KEY_DUPLICATED 错误
                            if (e.code === 406 && (e.errorMessage?.includes('AUTH_KEY_DUPLICATED') || e.message?.includes('AUTH_KEY_DUPLICATED'))) {
                                const { clearSession } = await import("../services/telegram.js");
                                await clearSession();
                                log.error(`🚨 关键错误: AUTH_KEY_DUPLICATED 检测到，已清除 Session。建议重启服务。`);
                                return false;
                            }
                            throw e;
                        }
                    },
                    userId,
                    options,
                    false,
                    3
                );
                return result !== false;
            } catch (e) {
                if (e.code === 406 && (e.errorMessage?.includes('AUTH_KEY_DUPLICATED') || e.message?.includes('AUTH_KEY_DUPLICATED'))) {
                    return false;
                }
                log.warn(`[safeEdit Failed] msgId ${msgId}:`, e.message, { chatId, msgId });
                return false;
            } finally {
                if (latestMessageEditIntents.get(queueKey) === intendedFingerprint) {
                    latestMessageEditIntents.delete(queueKey);
                }
            }
        })
        .finally(() => {
            if (messageEditQueues.get(queueKey) === next) {
                messageEditQueues.delete(queueKey);
            }
        });

    messageEditQueues.set(queueKey, next);
    return await next;
};

const safeSendStatusMessage = async (chatId, text, buttons = null, userId = null, parseMode = "html", options = {}) => {
    const { client } = await import("../services/telegram.js");
    try {
        await runBotTaskWithRetry(
            () => client.sendMessage(chatId, { message: text, buttons, parseMode }),
            userId,
            options,
            false,
            3
        );
        return true;
    } catch (e) {
        log.warn("[safeSendStatusMessage Failed]:", e.message, { chatId });
        return false;
    }
};

// 提取媒体元数据 (文件名、大小)
export const getMediaInfo = (input) => {
    // 兼容传入消息对象或媒体对象
    const media = input?.media || input;
    if (!media) return null;

    const photo = media.photo;
    const obj = media.document || media.video || photo;
    if (!obj) return null;
    let name = obj.attributes?.find(a => a.fileName)?.fileName;
    if (!name) {
        // Telegram 没有 fileName 属性(照片/无名文件)时自己编一个。
        // 必须用 Telegram 服务端的稳定标识(dcId + id)而不是时间戳/UUID：
        // 随机名每次都不同，同一张图重发会反复新传一份，去重永远命中不了。
        // dcId + id 对同一份媒体在 Telegram 侧恒定，所以重发会得到同名文件。
        const fingerprint = [obj.dcId, obj.id].filter(v => v !== undefined && v !== null).join('_');
        const ext = media.video ? ".mp4" : (photo ? ".jpg" : ".bin");
        name = fingerprint
            ? `transfer_${fingerprint}${ext}`
            : `transfer_${Date.now()}_${crypto.randomUUID().substring(0, 8)}${ext}`;
    }
    // MessageMediaPhoto.photo 是 Api.Photo 容器(不是 PhotoSize),自身没有 size;
    // 真实字节大小在 sizes/photo 数组里。读 obj.size 恒得 0,会让进度、去重和
    // rclone 的 --size 校验全失真(错值会让 rclone 收尾时误判 "corrupted on transfer")。
    // PhotoSizeProgressive 把各档尺寸放在 sizes 这个 int 数组里、自身没有 size,
    // 与 gramjs 的 Math.max(...thumb.sizes) 对齐。
    const photoSizes = photo ? (Array.isArray(photo) ? photo : (photo.sizes || photo.photo)) : null;
    const photoBytes = (s) => {
        if (!s) return 0;
        const direct = Number(s.size);
        const progressive = Array.isArray(s.sizes)
            ? Math.max(0, ...s.sizes.filter(Number.isFinite))
            : 0;
        return Math.max(Number.isFinite(direct) ? direct : 0, progressive);
    };
    const largestPhotoSize = Array.isArray(photoSizes)
        ? photoSizes.reduce((best, s) => (photoBytes(s) > photoBytes(best) ? s : best), null)
        : null;
    const size = obj.size || photoBytes(largestPhotoSize) || 0;
    const parsedSize = parseInt(size, 10);
    // sizeExact=false 表示"这是估算值,别拿它当字节数的判据"。
    //
    // document/video 的 obj.size 是 Telegram 服务端给的权威字节数,可以直接用。
    // 照片不行:gramjs 下载时自己挑档(_downloadPhoto → getThumb → 下载哪一档由它的
    // sortThumb 决定,progressive 取 Math.max(...sizes),cached/stripped 取 bytes.length),
    // 我们在这里重算只是近似。两边算法各自漂移 → 我们报 47379 而 rclone 实收 80482,
    // rclone 收尾拿 --size 一比就报 "corrupted on transfer: sizes differ",把一次
    // 完好的上传判成损坏,且该错误码不可重试,用户只能手动重发。
    //
    // 与其把 gramjs 的选档逻辑再抄一遍(已经漂移过一次,见上),不如承认照片大小
    // 事前不可知:让调用方对照片走"不校验字节数"的路径(见 DirectTransferService)。
    const sizeExact = !photo;
    return { name, size: Number.isFinite(parsedSize) ? parsedSize : 0, sizeExact };
};

// 统一更新任务状态 (带取消按钮)
export const updateStatus = async (task, text, isFinal = false, priority = null, showRetry = false) => {
    let buttons = null;
    if (!isFinal) {
        const cancelText = task.proc ? STRINGS.task.cancel_transfer_btn : STRINGS.task.cancel_task_btn;
        buttons = [Button.inline(cancelText, Buffer.from(`cancel_confirm_${task.id}`))];
    } else if (showRetry) {
        buttons = [Button.inline(STRINGS.task.retry_btn, Buffer.from(`retry_confirm_${task.id}`))];
    }
    const isHtml = /<\/?(b|i|code|pre|a)(\s|>)/i.test(text);
    const options = priority ? { priority } : {};
    const parseMode = isHtml ? 'html' : 'markdown';
    const edited = await safeEdit(task.chatId, task.msgId, text, buttons, task.userId, parseMode, options);
    if (!edited && isFinal) {
        return await safeSendStatusMessage(task.chatId, text, buttons, task.userId, parseMode, options);
    }
    return edited;
};

/**
 * 清洗 HTTP 响应头，剔除 Cloudflare 运维头和无用字段
 * 符合最佳实践：减少 Redis 存储占用，提升性能
 */
export const sanitizeHeaders = (headers) => {
    if (!headers) return {};

    // 如果是 Headers 对象，转为普通对象
    const rawHeaders = typeof headers.get === 'function'
        ? Object.fromEntries(headers.entries())
        : headers;

    const blacklist = [
        'nel', 'report-to', 'cf-ray', 'cf-cache-status',
        'server', 'alt-svc', 'date', 'connection',
        'x-powered-by', 'x-nf-request-id', 'cf-visitor'
    ];

    const cleanHeaders = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
        const lowerKey = key.toLowerCase();
        if (!blacklist.includes(lowerKey) && !lowerKey.startsWith('cf-')) {
            cleanHeaders[key] = value;
        }
    }
    return cleanHeaders;
};

/**
 * 安全的 toLowerCase()，先截断超长字符串再转小写
 * 防止 StringToLowerCaseIntl 在小内存容器中 OOM
 * @param {*} value - 要转换的值
 * @param {number} [maxLen=2000] - 最大长度
 * @returns {string}
 */
export const safeToLowerCase = (value, maxLen = 2000) => {
    const str = typeof value === 'string' ? value : String(value || '');
    const truncated = str.length > maxLen ? str.substring(0, maxLen) : str;
    return truncated.toLowerCase();
};

/**
 * 格式化字节大小为人类可读的字符串 (如 KB, MB, GB)
 * @param {number} bytes - 字节数
 * @param {number} [decimals=2] - 小数位数
 * @returns {string} 格式化后的字符串
 */
export const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};
