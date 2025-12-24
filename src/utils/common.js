import { Button } from "telegram/tl/custom/button.js";
import { client } from "../services/telegram.js";
import { runBotTask, runBotTaskWithRetry } from "./limiter.js";
import { STRINGS } from "../locales/zh-CN.js";

/**
 * --- 辅助工具函数 (Internal Helpers) ---
 */

/**
 * 转义 HTML 特殊字符，防止消息注入
 * @param {string} str 
 * @returns {string}
 */
export const escapeHTML = (str) => {
    if (!str) return "";
    return str
        .split('&').join('&')
        .split('<').join('<')
        .split('>').join('>')
        .split('"').join('"')
        .split("'").join('&#039;');
};

// 安全编辑消息，统一处理异常
export const safeEdit = async (chatId, msgId, text, buttons = null, userId = null, parseMode = "html") => {
    try {
        await runBotTaskWithRetry(
            () => client.editMessage(chatId, { message: msgId, text, buttons, parseMode }).catch(() => {}),
            userId,
            {},
            false,
            3
        );
    } catch (e) {}
};

// 提取媒体元数据 (文件名、大小)
export const getMediaInfo = (media) => {
    const obj = media.document || media.video || media.photo;
    if (!obj) return null;
    let name = obj.attributes?.find(a => a.fileName)?.fileName;
    if (!name) name = `transfer_${Math.floor(Date.now() / 1000)}${media.video ? ".mp4" : (media.photo ? ".jpg" : ".bin")}`;
    const size = obj.size || (obj.sizes ? obj.sizes[obj.sizes.length - 1].size : 0);
    return { name, size };
};

// 统一更新任务状态 (带取消按钮)
export const updateStatus = async (task, text, isFinal = false) => {
    const cancelText = task.proc ? STRINGS.task.cancel_transfer_btn : STRINGS.task.cancel_task_btn;
    const buttons = isFinal ? null : [Button.inline(cancelText, Buffer.from(`cancel_${task.id}`))];
    await safeEdit(task.chatId, task.msgId, text, buttons, task.userId, text.includes('<a href=') ? 'html' : 'markdown');
};