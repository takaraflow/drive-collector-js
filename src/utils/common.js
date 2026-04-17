import { Button } from "telegram/tl/custom/button.js";
import { client } from "../services/telegram.js";

/**
 * --- 辅助工具函数 (Internal Helpers) ---
 */

// 安全编辑消息，统一处理异常
export const safeEdit = async (chatId, msgId, text, buttons = null) => {
    try {
        await client.editMessage(chatId, { message: msgId, text, buttons, parseMode: "markdown" }).catch(() => {});
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
    const buttons = isFinal ? null : [Button.inline(task.proc ? "🚫 取消转存" : "🚫 取消任务", Buffer.from(`cancel_${task.id}`))];
    await safeEdit(task.chatId, task.msgId, text, buttons);
};