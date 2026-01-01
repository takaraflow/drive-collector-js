import { getClient, saveSession, clearSession, resetClientSession, setConnectionStatusCallback } from "../services/telegram.js";
import { MessageHandler } from "./MessageHandler.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { config } from "../config/index.js";
import { logger } from "../services/logger.js";

/**
 * Dispatcher 引导模块：负责 Telegram 客户端的启动、锁管理和消息处理
 */

/**
 * 启动 Dispatcher 组件
 * @returns {Promise<import("telegram").TelegramClient>} 返回已启动的 Telegram 客户端实例
 */
export async function startDispatcher() {
    logger.info("🔄 正在启动 Dispatcher 组件...");

    // --- 🤖 Telegram 客户端多实例协调启动 ---
    let isClientActive = false;
    let isClientStarting = false; // 防止重入标志

    // 设置连接状态回调，当连接断开时重置 isClientActive
    setConnectionStatusCallback((isConnected) => {
        if (!isConnected && isClientActive) {
            logger.info("🔌 Telegram 连接已断开，重置客户端状态");
            isClientActive = false;
        }
    });

    const startTelegramClient = async () => {
        // 防止重入：如果正在启动中，直接返回
        if (isClientStarting) {
            logger.debug("⏳ 客户端正在启动中，跳过本次重试...");
            return false;
        }

        // 检查是否已经持有锁（用于区分首次获取和续租）
        const alreadyHasLock = await instanceCoordinator.hasLock("telegram_client");
        
        // 尝试获取 Telegram 客户端专属锁 (增加 TTL 到 90s，减少因延迟导致的丢失)
        // 增加重试次数到 5 次，以应对发版时新旧实例交替的短暂冲突
        const hasLock = await instanceCoordinator.acquireLock("telegram_client", 90, { maxAttempts: 5 });
        
        if (!hasLock) {
            if (isClientActive) {
                // 只有在真正失去锁时才记录警告日志
                logger.warn("🚨 失去 Telegram 锁，正在断开连接...");
                try {
                    // 强制断开，并设置较短的超时防止卡死在 disconnect
                    const client = await getClient();
                    await Promise.race([
                        client.disconnect(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 5000))
                    ]);
                } catch (e) {
                    logger.error("⚠️ 断开连接时出错:", e.message);
                }
                isClientActive = false;
            } else {
                // 静默续租失败，但客户端未激活，只需调试日志
                logger.debug("🔒 续租失败，客户端未激活");
            }
            return false;
        }

        // 成功获取锁
        if (isClientActive) {
            // 续租成功，只在调试模式下记录
            if (alreadyHasLock) {
                logger.debug("🔒 静默续租成功");
            }
            return true;
        }

        isClientStarting = true; // 标记开始启动
        
        // 首次获取锁，记录信息日志
        if (!alreadyHasLock) {
            logger.info("👑 已获取 Telegram 锁，正在启动客户端...");
        } else {
            logger.debug("🔒 续租成功，客户端已激活");
        }

        let retryCount = 0;
        const maxRetries = 3;

        try {
            while (!isClientActive && retryCount < maxRetries) {
                try {
                    const client = await getClient();
                    await client.start({ botAuthToken: config.botToken });
                    await saveSession();
                    logger.info("🚀 Telegram 客户端已连接");
                    isClientActive = true;
                    isClientStarting = false;
                    return true;
                } catch (error) {
                    retryCount++;

                    if (error.code === 406 && error.errorMessage?.includes('AUTH_KEY_DUPLICATED')) {
                        logger.warn(`⚠️ 检测到 AUTH_KEY_DUPLICATED 错误 (尝试 ${retryCount}/${maxRetries})`);
                        
                        // 2. 检查是否仍然持有锁（在重置之前检查）
                        const stillHasLock = await instanceCoordinator.hasLock("telegram_client");
                        if (!stillHasLock) {
                            logger.warn("🚨 在处理 AUTH_KEY_DUPLICATED 时失去锁，停止重试");
                            isClientActive = false;
                            isClientStarting = false;
                            return false;
                        }
                        
                        // 1. 进行本地 Session 重置
                        await resetClientSession();
                        
                        // 3. 如果重试次数未达到上限，继续尝试（不清除全局 Session）
                        if (retryCount < maxRetries) {
                            logger.info("🔄 尝试重新连接（保持全局 Session 不变）...");
                            if (process.env.NODE_ENV !== 'test') {
                                await new Promise(r => setTimeout(r, 2000));
                            }
                            continue;
                        }
                        
                        // 4. 如果多次重试仍然失败，说明全局 Session 已损坏，清除全局 Session
                        logger.warn("🚨 多次重试后仍然 AUTH_KEY_DUPLICATED，清除全局 Session");
                        await clearSession(); // 清除全局 Session
                        if (process.env.NODE_ENV !== 'test') {
                            await new Promise(r => setTimeout(r, 2000));
                        }
                        continue;
                    }

                    logger.error(`❌ 启动 Telegram 客户端失败 (尝试 ${retryCount}/${maxRetries}):`, error.message);

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
            await startTelegramClient();
            // 递归调用以实现持续的带抖动的间隔
            startIntervalWithJitter();
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

    logger.info("🎉 Dispatcher 组件启动完成！");
    return await getClient();
}