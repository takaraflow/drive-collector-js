import { Button } from "telegram/tl/custom/button.js";
import { runBotTask, runBotTaskWithRetry } from "./limiter.js";
import { STRINGS } from "../locales/zh-CN.js";
import { logger } from "../services/logger/index.js";
import crypto from "crypto";

const log = logger.withModule ? logger.withModule('CommonUtils') : logger;

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
    // 延迟导入 client 避免循环依赖
    const { client } = await import("../services/telegram.js");
    try {
        await runBotTaskWithRetry(
            async () => {
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
                        return;
                    }
                    throw e;
                }
            },
            userId,
            options,
            false,
            3
        );
    } catch (e) {
        // 最终失败也不抛出，避免中断主流程
        if (e.code === 406 && (e.errorMessage?.includes('AUTH_KEY_DUPLICATED') || e.message?.includes('AUTH_KEY_DUPLICATED'))) {
            return; // 已经在内部处理过了
        }
        log.warn(`[safeEdit Failed] msgId ${msgId}:`, e.message);
    }
};

// 提取媒体元数据 (文件名、大小)
export const getMediaInfo = (input) => {
    // 兼容传入消息对象或媒体对象
    const media = input?.media || input;
    if (!media) return null;

    const obj = media.document || media.video || media.photo;
    if (!obj) return null;
    let name = obj.attributes?.find(a => a.fileName)?.fileName;
    if (!name) {
        // 使用时间戳 + UUID 确保文件名唯一，特别是在处理媒体组时
        const uuid = crypto.randomUUID().substring(0, 8);
        const timestamp = Date.now();
        const ext = media.video ? ".mp4" : (media.photo ? ".jpg" : ".bin");
        name = `transfer_${timestamp}_${uuid}${ext}`;
    }
    const size = obj.size || (obj.sizes ? obj.sizes[obj.sizes.length - 1].size : 0);
    const parsedSize = parseInt(size, 10);
    return { name, size: Number.isFinite(parsedSize) ? parsedSize : 0 };
};

// 统一更新任务状态 (带取消按钮)
export const updateStatus = async (task, text, isFinal = false, priority = null) => {
    const cancelText = task.proc ? STRINGS.task.cancel_transfer_btn : STRINGS.task.cancel_task_btn;
    const buttons = isFinal ? null : [Button.inline(cancelText, Buffer.from(`cancel_${task.id}`))];
    // 增强 HTML 检测：包含常见标签即视为 HTML 模式
    const isHtml = /<\/?(b|i|code|pre|a)(\s|>)/i.test(text);
    const options = priority ? { priority } : {};
    await safeEdit(task.chatId, task.msgId, text, buttons, task.userId, isHtml ? 'html' : 'markdown', options);
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
