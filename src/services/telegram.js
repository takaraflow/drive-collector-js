import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import logger from "./logger.js";

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
 * @param {boolean} isLocal - 是否仅清除本地 Session，默认为 false（清除全局）
 */
export const clearSession = async (isLocal = false) => {
    try {
        if (isLocal) {
            logger.info("🗑️ 仅清除本地 Session，不修改全局设置");
            return;
        }
        await SettingsRepository.set("tg_bot_session", "");
        logger.info("🗑️ Telegram 全局 Session 已清除");
    } catch (e) {
        logger.error("❌ 清除 Session 失败:", e);
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
            logger.info("💾 Telegram Session 已持久化");
        }
    } catch (e) {
        logger.error("❌ 保存 Session 失败:", e);
    }
};

/**
 * 重置客户端 Session 为空（用于 AUTH_KEY_DUPLICATED 恢复）
 */
export const resetClientSession = async () => {
    try {
        if (client.connected) {
            logger.info("🔌 正在断开 Telegram 客户端连接...");
            await client.disconnect();
        }

        // 彻底销毁旧的连接器状态 (如果是 TIMEOUT 错误，可能内部状态已损坏)
        // GramJS 内部会管理 _sender，这里手动清理以防万一
        if (client._sender) {
            try {
                await client._sender.disconnect();
            } catch (e) {
                logger.warn("⚠️ 清理 GramJS _sender 失败:", e);
            }
            client._sender = undefined; // 清除引用
        }

        // 将当前客户端的 Session 替换为空的新 Session
        client.session = new StringSession("");
        logger.info("🔄 客户端内存 Session 已重置，准备重新连接...");
    } catch (e) {
        logger.error("❌ 重置内存 Session 失败:", e);
    }
};

// 初始化 Telegram 客户端单例
// 优化配置以应对限流和连接问题：增加重试次数，模拟真实设备信息，设置 FloodWait 阈值
// 增强连接稳定性和数据中心切换处理

// 代理配置处理
const proxyOptions = config.telegram?.proxy?.host ? {
    proxy: {
        ip: config.telegram.proxy.host,
        port: parseInt(config.telegram.proxy.port),
        socksType: config.telegram.proxy.type === 'socks5' ? 5 : 4,
        username: config.telegram.proxy.username,
        password: config.telegram.proxy.password,
    }
} : {};

export const client = new TelegramClient(
    new StringSession(await getSavedSession()),
    config.apiId,
    config.apiHash,
    {
        connectionRetries: 20, // 增加连接重试次数到 20
        floodSleepThreshold: 30, // 自动处理 30 秒内的 FloodWait，降低阈值让更多错误暴露给应用层
        deviceModel: "DriveCollector-Server",
        systemVersion: "Linux",
        appVersion: "2.3.3", // 更新版本号
        useWSS: false, // 服务端环境下通常不需要 WSS
        autoReconnect: true,
        // 增强连接稳定性设置
        timeout: 30000, // 调整连接超时到 30 秒
        requestRetries: 10, // 增加请求重试次数
        retryDelay: 3000, // 增加重试延迟
        // 数据中心切换优化
        dcId: undefined, // 让客户端自动选择最佳数据中心
        useIPv6: false, // 禁用 IPv6 以提高兼容性
        // 连接池设置
        maxConcurrentDownloads: 3, // 限制并发下载数量
        connectionPoolSize: 5, // 连接池大小
        // 添加基础日志记录器
        baseLogger: logger,
        ...proxyOptions // 合并代理配置
    }
);

// --- 🛡️ 客户端监控与健康检查 (Watchdog) ---
let lastHeartbeat = Date.now();
let isReconnecting = false;
let connectionStatusCallback = null; // 连接状态变化回调
let watchdogTimer = null;
let reconnectTimeout = null;

/**
 * 设置连接状态变化回调
 * @param {function} callback - 当连接状态变化时调用的函数，参数：(isConnected: boolean)
 */
export const setConnectionStatusCallback = (callback) => {
    connectionStatusCallback = callback;
};

// 监听连接状态变化
client.on("connected", () => {
    logger.info("🔗 Telegram 客户端连接已建立");
    if (connectionStatusCallback) {
        connectionStatusCallback(true);
    }
});

client.on("disconnected", () => {
    logger.info("🔌 Telegram 客户端连接已断开");
    if (connectionStatusCallback) {
        connectionStatusCallback(false);
    }
});

// 监听错误以防止更新循环因超时而崩溃
client.on("error", (err) => {
    const errorMsg = err?.message || "";
    
    // 识别 BinaryReader 相关的 TypeError
    const isBinaryReaderError = 
        errorMsg.includes("readUInt32LE") || 
        errorMsg.includes("readInt32LE") ||
        (err instanceof TypeError && errorMsg.includes("undefined"));
    
    if (errorMsg.includes("TIMEOUT")) {
        // TIMEOUT 通常发生在 _updateLoop 中，GramJS 可能已经进入不可恢复状态
        logger.warn(`⚠️ Telegram 客户端更新循环超时 (TIMEOUT): ${errorMsg}，准备主动重连...`);
        // 增加延迟避免在网络波动时频繁重连
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => handleConnectionIssue(), 2000);
    } else if (errorMsg.includes("Not connected")) {
        logger.warn("⚠️ Telegram 客户端未连接，尝试重连...");
        handleConnectionIssue();
    } else if (isBinaryReaderError) {
        // 处理 BinaryReader 相关的 TypeError，这通常意味着内部状态已损坏
        logger.warn(`⚠️ Telegram 客户端发生 BinaryReader 错误 (${errorMsg})，准备主动重连...`);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => handleConnectionIssue(), 2000);
    } else {
        logger.error("❌ Telegram 客户端发生错误:", err);
    }
});

/**
 * 处理连接异常情况
 */
async function handleConnectionIssue() {
    if (isReconnecting) return;
    
    // 关键：重连前必须确认自己仍然持有锁
    try {
        const hasLock = await instanceCoordinator.hasLock("telegram_client");
        if (!hasLock) {
            logger.warn("🚨 明确失去锁，取消主动重连");
            return;
        }
    } catch (e) {
        logger.warn(`⚠️ 检查锁状态失败（KV 异常），暂缓重连以防竞争: ${e.message}`);
        return; // 暂缓，等待下一轮 watchdog 或系统重试
    }

    isReconnecting = true;

    try {
        // 记录客户端状态上下文
        logger.info(`🔄 正在触发主动重连序列... [connected=${client.connected}, _sender=${!!client._sender}]`);

        // 尝试优雅断开（带超时）
        try {
            if (client.connected) {
                // 给 disconnect 一个超时，防止它也卡死
                await Promise.race([
                    client.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 5000))
                ]);
            }
        } catch (de) {
            logger.warn("⚠️ 断开连接时异常（可能是已断开）:", de);
        }

        // 彻底销毁旧的连接器状态 (如果是 TIMEOUT 错误，可能内部状态已损坏)
        if (client._sender) {
            try {
                await client._sender.disconnect();
                client._sender = undefined; // 清除引用
                logger.info("✅ 已清理旧的 _sender 状态");
            } catch (e) {
                logger.warn("⚠️ 清理 _sender 失败:", e);
                client._sender = undefined; // 即使失败也清除引用
            }
        }

        // 清理旧状态
        await resetClientSession();

        // 增加冷却期以避免频繁重连（5-10秒随机延迟）
        const coolDownTime = 5000 + Math.random() * 5000;
        logger.info(`⏳ 冷却期 ${Math.floor(coolDownTime/1000)}s，避免频繁重连...`);
        await new Promise(r => setTimeout(r, coolDownTime));

        // 重新连接
        await client.connect();
        logger.info("✅ 客户端主动重连成功");
        lastHeartbeat = Date.now(); // 重置心跳
        
        // 记录连接后的状态
        logger.info(`🔗 连接状态确认: connected=${client.connected}`);
        
    } catch (e) {
        logger.error("❌ 主动重连失败，等待系统自动处理:", e);
        // 增加错误日志上下文
        logger.error(`🔍 重连失败状态: connected=${client.connected}, _sender=${!!client._sender}, error=${e.message}`);
    } finally {
        isReconnecting = false;
    }
}

/**
 * 启动看门狗定时器
 */
export const startWatchdog = () => {
    // 定时检查心跳（通过获取自身信息）
    watchdogTimer = setInterval(async () => {
        const now = Date.now();

        // [DEBUG] 打印状态
        // console.log(`[DEBUG_FIX] Watchdog check. now=${now}, last=${lastHeartbeat}, isReconnecting=${isReconnecting}, connected=${client.connected}`);

        // 必须在 isReconnecting 检查之前处理时间回拨，防止测试环境下锁死
        // 处理时间回拨（如测试环境重置时间或系统时钟同步）
        if (lastHeartbeat > now) {
            logger.info(`🕒 检测到时间回拨，重置心跳时间: last=${lastHeartbeat}, now=${now}`);
            lastHeartbeat = now;
            isReconnecting = false;
        }

        if (isReconnecting) {
            // console.log(`[DEBUG_FIX] Skipping check because isReconnecting=true`);
            return;
        }

        if (!client.connected) {
            // 如果已断开连接且超过 5 分钟没有恢复，也触发强制重连
            if (now - lastHeartbeat >= 5 * 60 * 1000) {
                logger.error(`🚨 客户端断开连接超过 5 分钟且未自动恢复，强制重启连接... (diff=${now - lastHeartbeat})`);
                handleConnectionIssue();
            }
            return;
        }

        try {
            await client.getMe();
            lastHeartbeat = Date.now();
            // console.log(`[DEBUG_FIX] Heartbeat success. lastHeartbeat updated to ${lastHeartbeat}`);
        } catch (e) {
            if (e.code === 406 && e.errorMessage?.includes("AUTH_KEY_DUPLICATED")) {
                logger.error("🚨 检测到 AUTH_KEY_DUPLICATED，会话已在别处激活，本实例应停止连接");
                // 标记需要重置，并释放本地状态
                lastHeartbeat = 0; // 触发强制处理
                // 主动断开连接
                try {
                    await client.disconnect();
                } catch (disconnectError) {
                    logger.warn("⚠️ 断开连接时出错:", disconnectError);
                }
                // 清理本地状态
                await resetClientSession();
                // 释放锁（如果持有）
                await instanceCoordinator.releaseLock("telegram_client");
                return;
            }

            logger.warn("💔 心跳检测失败:", e);

            // 使用当前时间再次检查差值，因为 await getMe() 可能经过了时间
            const currentNow = Date.now();
            const diff = currentNow - lastHeartbeat;
            // console.log(`[DEBUG_FIX] Heartbeat failed. Diff=${diff}`);

            if (diff >= 5 * 60 * 1000) {
                logger.error(`🚨 超过 5 分钟无心跳响应，强制重启连接... (diff=${diff})`);
                handleConnectionIssue();
            }
        }
    }, 60 * 1000); // 每分钟检查一次
};

/**
 * 停止看门狗定时器
 */
export const stopWatchdog = () => {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    isReconnecting = false;
    lastHeartbeat = Date.now(); // 重置心跳时间
};

/**
 * 确保客户端已连接，如果未连接则等待连接建立
 */
export const ensureConnected = async () => {
    if (client.connected) return;

    logger.info("⏳ 等待 Telegram 客户端连接...");
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Telegram client connection timeout after 30 seconds"));
        }, 30000);

        const checkConnected = () => {
            if (client.connected) {
                clearTimeout(timeout);
                logger.info("✅ Telegram 客户端连接已确认");
                resolve();
            } else {
                setTimeout(checkConnected, 1000);
            }
        };
        checkConnected();
    });
};

/**
 * 获取客户端活跃状态
 */
export const isClientActive = () => client.connected;

// 启动看门狗
startWatchdog();