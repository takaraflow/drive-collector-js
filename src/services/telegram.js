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
 * 清除保存的 Session 字符串（用于解决 AUTH_KEY_DUPLICATED 问题）
 */
export const clearSession = async () => {
    try {
        await SettingsRepository.set("tg_bot_session", "");
        console.log("🗑️ Telegram Session 已清除");
    } catch (e) {
        console.error("❌ 清除 Session 失败:", e);
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

/**
 * 重置客户端 Session 为空（用于 AUTH_KEY_DUPLICATED 恢复）
 */
export const resetClientSession = () => {
    try {
        // 将当前客户端的 Session 替换为空的新 Session
        client.session = new StringSession("");
        console.log("🔄 客户端内存 Session 已重置");
    } catch (e) {
        console.error("❌ 重置内存 Session 失败:", e);
    }
};

// 初始化 Telegram 客户端单例
// 优化配置以应对限流和连接问题：增加重试次数，模拟真实设备信息，设置 FloodWait 阈值
// 增强连接稳定性和数据中心切换处理
export const client = new TelegramClient(
    new StringSession(await getSavedSession()),
    config.apiId,
    config.apiHash,
    {
        connectionRetries: 15, // 增加连接重试次数
        floodSleepThreshold: 60, // 自动处理 60 秒内的 FloodWait
        deviceModel: "DriveCollector-Server",
        systemVersion: "Linux",
        appVersion: "2.3.0", // 更新版本号
        useWSS: false, // 服务端环境下通常不需要 WSS
        autoReconnect: true,
        // 增强连接稳定性设置
        timeout: 30000, // 连接超时 30 秒
        requestRetries: 5, // 请求重试次数
        retryDelay: 2000, // 重试延迟 2 秒
        // 数据中心切换优化
        dcId: undefined, // 让客户端自动选择最佳数据中心
        useIPv6: false, // 禁用 IPv6 以提高兼容性
        // 连接池设置
        maxConcurrentDownloads: 3, // 限制并发下载数量
        connectionPoolSize: 5 // 连接池大小
    }
);

// --- 🛡️ 客户端监控与健康检查 (Watchdog) ---
let lastHeartbeat = Date.now();
let isReconnecting = false;

// 监听错误以防止更新循环因超时而崩溃
client.on("error", (err) => {
    if (err.message && err.message.includes("TIMEOUT")) {
        console.warn("⚠️ Telegram 客户端更新循环超时 (TIMEOUT)，检测连接状态...");
        handleConnectionIssue();
    } else if (err.message && err.message.includes("Not connected")) {
        console.warn("⚠️ Telegram 客户端未连接，尝试重连...");
        handleConnectionIssue();
    } else {
        console.error("❌ Telegram 客户端发生错误:", err);
    }
});

/**
 * 处理连接异常情况
 */
async function handleConnectionIssue() {
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        console.log("🔄 正在触发主动重连序列...");
        // 尝试断开并重新连接
        if (client.connected) {
            await client.disconnect();
        }
        await new Promise(r => setTimeout(r, 5000));
        await client.connect();
        console.log("✅ 客户端主动重连成功");
    } catch (e) {
        console.error("❌ 主动重连失败，等待系统自动处理:", e.message);
    } finally {
        isReconnecting = false;
    }
}

// 定时检查心跳（通过获取自身信息）
setInterval(async () => {
    if (!client.connected || isReconnecting) return;
    
    try {
        // 简单的 API 调用测试连通性
        await client.getMe();
        lastHeartbeat = Date.now();
    } catch (e) {
        console.warn("💔 心跳检测失败:", e.message);
        if (Date.now() - lastHeartbeat > 5 * 60 * 1000) {
            console.error("🚨 超过 5 分钟无心跳响应，强制重启连接...");
            handleConnectionIssue();
        }
    }
}, 60 * 1000); // 每分钟检查一次