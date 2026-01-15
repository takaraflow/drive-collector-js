import { config } from "../config/index.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule('TelegramBotApi');

/**
 * 极简 Telegram Bot API 客户端
 * 用于 Worker 实例在不持有 MTProto 锁的情况下更新 UI
 */
export class TelegramBotApi {
    /**
     * 调用 Bot API 方法
     */
    static async call(method, params = {}) {
        const token = config.botToken;
        if (!token) throw new Error("BOT_TOKEN not configured");

        const isTestMode = config.telegram?.testMode;
        const url = `https://api.telegram.org/bot${token}${isTestMode ? '/test' : ''}/${method}`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });

            const data = await response.json();
            if (!data.ok) {
                // 忽略一些常见的非致命错误
                if (data.description?.includes("message is not modified")) return data;
                log.warn(`Bot API ${method} failed:`, data.description);
            }
            return data;
        } catch (error) {
            log.error(`Bot API request error:`, error.message);
            throw error;
        }
    }

    /**
     * 编辑消息文本
     */
    static async editMessageText(chatId, messageId, text, options = {}) {
        return this.call('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: options.parseMode || 'HTML',
            reply_markup: options.buttons ? { inline_keyboard: options.buttons } : undefined
        });
    }
}