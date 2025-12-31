import { Button } from "telegram/tl/custom/button.js";
import { runBotTask, runBotTaskWithRetry } from "./limiter.js";
import { STRINGS } from "../locales/zh-CN.js";
import { logger } from "../services/logger.js";

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
export const safeEdit = async (chatId, msgId, text, buttons = null, userId = null, parseMode = "html") => {
    // 延迟导入 client 避免循环依赖
    const { client } = await import("../services/telegram.js");
    try {
        await runBotTaskWithRetry(
            async () => {
                try {
                    await client.editMessage(chatId, { message: msgId, text, buttons, parseMode });
                } catch (e) {
                    // 忽略 "Message Not Modified" 错误，这是由于更新内容完全一致导致的
                    if (e.message && (e.message.includes("MESSAGE_NOT_MODIFIED") || e.code === 400 && e.errorMessage === "MESSAGE_NOT_MODIFIED")) {
                        return;
                    }
                    // 处理 AUTH_KEY_DUPLICATED 错误
                    if (e.code === 406 && (e.errorMessage?.includes('AUTH_KEY_DUPLICATED') || e.message?.includes('AUTH_KEY_DUPLICATED'))) {
                        const { clearSession } = await import("../services/telegram.js");
                        await clearSession();
                        logger.error(`🚨 关键错误: AUTH_KEY_DUPLICATED 检测到，已清除 Session。建议重启服务。`);
                        // 不再重试，因为 Session 已失效
                        return;
                    }
                    throw e;
                }
            },
            userId,
            {},
            false,
            3
        );
    } catch (e) {
        // 最终失败也不抛出，避免中断主流程
        if (e.code === 406 && (e.errorMessage?.includes('AUTH_KEY_DUPLICATED') || e.message?.includes('AUTH_KEY_DUPLICATED'))) {
            return; // 已经在内部处理过了
        }
        logger.warn(`[safeEdit Failed] msgId ${msgId}:`, e.message);
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
        // 使用时间戳 + 6位随机字符串确保文件名唯一，特别是在处理媒体组时
        const nonce = Math.random().toString(36).substring(2, 8);
        const timestamp = Date.now();
        const ext = media.video ? ".mp4" : (media.photo ? ".jpg" : ".bin");
        name = `transfer_${timestamp}_${nonce}${ext}`;
    }
    const size = obj.size || (obj.sizes ? obj.sizes[obj.sizes.length - 1].size : 0);
    return { name, size };
};

// 统一更新任务状态 (带取消按钮)
export const updateStatus = async (task, text, isFinal = false) => {
    const cancelText = task.proc ? STRINGS.task.cancel_transfer_btn : STRINGS.task.cancel_task_btn;
    const buttons = isFinal ? null : [Button.inline(cancelText, Buffer.from(`cancel_${task.id}`))];
    // 增强 HTML 检测：包含常见标签即视为 HTML 模式
    const isHtml = /<\/?(b|i|code|pre|a)(\s|>)/i.test(text);
    await safeEdit(task.chatId, task.msgId, text, buttons, task.userId, isHtml ? 'html' : 'markdown');
};