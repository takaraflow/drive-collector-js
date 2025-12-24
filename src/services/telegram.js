import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";

/**
 * 获取持久化的 Session 字符串
 */
const getSavedSession = async () => {
    try {
        return await SettingsRepository.get("tg_bot_session", "");
    } catch (e) {
        return "";
    }
};

/**
 * 保存当前的 Session 字符串
 */
export const saveSession = async () => {
    try {
        const sessionStr = client.session.save();
        if (sessionStr) {
            await SettingsRepository.set("tg_bot_session", sessionStr);
            console.log("💾 Telegram Session 已持久化");
        }
    } catch (e) {
        console.error("❌ 保存 Session 失败:", e);
    }
};

// 初始化 Telegram 客户端单例
// 优化配置以应对限流：增加重试次数，模拟真实设备信息，设置 FloodWait 阈值
// 使用动态加载的 Session
export const client = new TelegramClient(
    new StringSession(await getSavedSession()), 
    config.apiId, 
    config.apiHash, 
    { 
        connectionRetries: 10,
        floodSleepThreshold: 60, // 自动处理 60 秒内的 FloodWait
        deviceModel: "DriveCollector-Server",
        systemVersion: "Linux",
        appVersion: "1.2.0",
        useWSS: false, // 服务端环境下通常不需要 WSS
        autoReconnect: true
    }
);