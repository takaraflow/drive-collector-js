import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";

// 初始化 Telegram 客户端单例
// 优化配置以应对限流：增加重试次数，模拟真实设备信息，设置 FloodWait 阈值
export const client = new TelegramClient(
    new StringSession(""), 
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