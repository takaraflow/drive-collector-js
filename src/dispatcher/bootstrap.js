import { getClient, startTelegramWatchdog, saveSession, resetClientSession, clearSession, setConnectionStatusCallback } from "../services/telegram.js";
import { MessageHandler } from "./MessageHandler.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { logger } from "../services/logger/index.js";
import { getConfig } from "../config/index.js";

const log = logger.withModule ? logger.withModule('DispatcherBootstrap') : logger;

/**
 * Dispatcher 引导模块：负责 Telegram 客户端的启动、锁管理和消息处理
 */

/**
 * 启动 Dispatcher 组件
 * @returns {Promise<import("telegram").TelegramClient>} 返回已启动的 Telegram 客户端实例
 */
export async function startDispatcher() {
    log.info("🔄 正在启动 Dispatcher 组件...");

    // --- 🤖 Telegram 客户端多实例协调启动 ---
    let isClientActive = false;
    let isClientStarting = false; // 防止重入标志
    let connectionRetries = 0;
    const MAX_CONNECTION_RETRIES = 5;

    // 设置连接状态回调，当连接断开时重置 isClientActive
    setConnectionStatusCallback((isConnected) => {
        log.debug(`🔌 Telegram 连接状态变化: ${isConnected ? '已连接' : '已断开'}`);
        if (!isConnected && isClientActive) {
            log.info("🔌 Telegram 连接已断开，重置客户端状态");
            isClientActive = false;
            
            // 自动尝试重新连接
            if (connectionRetries < MAX_CONNECTION_RETRIES) {
                connectionRetries++;
                log.info(`🔄 尝试重新连接 (${connectionRetries}/${MAX_CONNECTION_RETRIES})...`);
                setTimeout(startTelegramClient, 3000);
            } else {
                log.error("🚨 达到最大重连次数，请检查网络连接");
            }
        }
    });

    // 添加全局错误处理
    if (typeof process !== 'undefined' && process.on) {
        process.on('uncaughtException', async (err) => {
            if (err.message.includes('Not connected')) {
                log.warn("⚠️ 捕获到 'Not connected' 错误，正在重置客户端状态");
                isClientActive = false;
                return;
            }
            log.error("🚨 未捕获的异常:", err);
        });
    }

    let loopCount = 0;
    const startTelegramClient = async () => {
        const currentLoop = ++loopCount;
        log.debug(`[Loop ${currentLoop}] 🔄 开始执行 startTelegramClient...`);
        
        // 防止重入：如果正在启动中，直接返回
        if (isClientStarting) {
            log.debug(`[Loop ${currentLoop}] ⏳ 客户端正在启动中，跳过本次重试...`);
            return false;
        }

        // 检查是否已经持有锁（用于区分首次获取和续租）
        // 添加错误处理：防止 hasLock 抛出异常导致循环终止
        let alreadyHasLock = false;
        try {
            alreadyHasLock = await instanceCoordinator.hasLock("telegram_client");
        } catch (error) {
            log.error(`[Loop ${currentLoop}] 🔒 锁检查失败: ${error.message}`);
            // 返回 false 但不抛出异常，让循环继续
            return false;
        }
        
        // 尝试获取 Telegram 客户端专属锁 (增加 TTL 到 90s，减少因延迟导致的丢失)
        // 增加重试次数到 5 次，以应对发版时新旧实例交替的短暂冲突
        const hasLock = await instanceCoordinator.acquireLock("telegram_client", 90, { maxAttempts: 5 });
        
        if (!hasLock) {
            if (isClientActive) {
                // 只有在真正失去锁时才记录警告日志
                log.warn("🚨 失去 Telegram 锁，正在断开连接...");
                try {
                    // 强制断开，并设置较短的超时防止卡死在 disconnect
                    const client = await getClient();
                    try {
                        await Promise.race([
                            client.disconnect(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 5000))
                        ]);
                    } catch (e) {
                        if (e.message === "Not connected") {
                            log.debug("ℹ️ 客户端已断开，无需再次断开");
                        } else {
                            throw e;
                        }
                    }
                } catch (e) {
                    log.error("⚠️ 断开连接时出错:", e.message);
                }
                isClientActive = false;
            } else {
                // 静默续租失败，但客户端未激活，只需调试日志
                log.debug("🔒 续租失败，客户端未激活");
            }
            return false;
        }

        // 成功获取锁
        if (isClientActive) {
            // 续租成功，只在调试模式下记录
            if (alreadyHasLock) {
                log.debug("🔒 静默续租成功");
            }
            return true;
        }

        isClientStarting = true; // 标记开始启动
        
        // 首次获取锁，记录信息日志
        if (!alreadyHasLock) {
            log.info("👑 已获取 Telegram 锁，正在启动客户端...");
        } else {
            log.debug("🔒 续租成功，客户端已激活");
        }

        let retryCount = 0;
        const maxRetries = 3;

        try {
            while (!isClientActive && retryCount < maxRetries) {
                try {
                    const config = getConfig();
                    const client = await getClient();
                    try {
                        await client.start({ botAuthToken: config.botToken });
                        await saveSession();
                        log.info("🚀 Telegram 客户端已连接");
                    } catch (error) {
                        log.error("❌ Telegram 客户端连接失败", error);
                        throw error; // 确保被全局错误处理器捕获
                    }
                    isClientActive = true;
                    isClientStarting = false;
                    return true;
                } catch (error) {
                    retryCount++;

                    if (error.code === 406 && error.errorMessage?.includes('AUTH_KEY_DUPLICATED')) {
                        log.warn(`⚠️ 检测到 AUTH_KEY_DUPLICATED 错误 (尝试 ${retryCount}/${maxRetries})`);
                        
                        // 2. 检查是否仍然持有锁（在重置之前检查）
                        const stillHasLock = await instanceCoordinator.hasLock("telegram_client");
                        if (!stillHasLock) {
                            log.warn("🚨 在处理 AUTH_KEY_DUPLICATED 时失去锁，停止重试");
                            isClientActive = false;
                            isClientStarting = false;
                            return false;
                        }
                        
                        // 1. 进行本地 Session 重置
                        await resetClientSession();
                        
                        // 3. 如果重试次数未达到上限，继续尝试（不清除全局 Session）
                        if (retryCount < maxRetries) {
                            log.info("🔄 尝试重新连接（保持全局 Session 不变）...");
                            if (process.env.NODE_ENV !== 'test') {
                                await new Promise(r => setTimeout(r, 2000));
                            }
                            continue;
                        }
                        
                        // 4. 如果多次重试仍然失败，说明全局 Session 已损坏，清除全局 Session
                        log.warn("🚨 多次重试后仍然 AUTH_KEY_DUPLICATED，清除全局 Session");
                        await clearSession(); // 清除全局 Session
                        if (process.env.NODE_ENV !== 'test') {
                            await new Promise(r => setTimeout(r, 2000));
                        }
                        continue;
                    }

                    log.error(`❌ 启动 Telegram 客户端失败 (尝试 ${retryCount}/${maxRetries}):`, error.message);

                    // 如果不是 Auth Key 问题，增加一点延迟再重试，避免瞬间刷爆
                    if (retryCount < maxRetries) {
                        if (process.env.NODE_ENV !== 'test') {
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                }
            }
        } finally {
            // 无论成功失败，最后都要清除启动标志
            isClientStarting = false;
            log.debug(`[Loop ${currentLoop}] ✅ startTelegramClient 执行完毕`);
        }
        return isClientActive;
    };

    // 初始启动尝试
    await startTelegramClient();

    // 定期检查/续租锁，加入随机抖动防止多个实例同时触发
    const startIntervalWithJitter = () => {
        // 基础间隔 60s，加上 ±10s 的随机抖动
        // 间隔时间应小于锁的 TTL (90s)，但足够长以减少 KV 调用
        const jitter = Math.random() * 20000 - 10000; // -10000 到 +10000ms
        const interval = 60000 + jitter;
        
        setTimeout(async () => {
            try {
                await startTelegramClient();
            } catch (error) {
                // 安全网：捕获所有未处理的异常，防止循环终止
                log.error(`🛡️ 后台循环错误已捕获，继续执行: ${error.message}`);
            } finally {
                // 无论成功失败，始终继续循环
                startIntervalWithJitter();
            }
        }, interval);
    };
    
    // 启动带抖动的间隔 (在测试环境下禁用自动循环)
    if (process.env.NODE_ENV !== 'test') {
        startIntervalWithJitter();
    }

    // 4. 注册事件监听器 -> 交给 MessageHandler 处理
    // 初始化 MessageHandler (预加载 Bot ID)
    const client = await getClient();
    client.addEventHandler(async (event) => {
        await MessageHandler.handleEvent(event, client);
    });

    // 延迟初始化 Bot ID (等待连接建立)
    setTimeout(() => MessageHandler.init(client), 5000);

    // 延迟启动看门狗（确保 InstanceCoordinator 完成初始化后再启动）
    setTimeout(() => {
        startTelegramWatchdog();
        log.info("🐶 Telegram 看门狗已启动");
    }, 1000);

    log.info("🎉 Dispatcher 组件启动完成！");
    return await getClient();
}