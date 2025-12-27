import { client, saveSession, clearSession, resetClientSession, setConnectionStatusCallback } from "../services/telegram.js";
import { MessageHandler } from "./MessageHandler.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { config } from "../config/index.js";

/**
 * Dispatcher 引导模块：负责 Telegram 客户端的启动、锁管理和消息处理
 */

/**
 * 启动 Dispatcher 组件
 * @returns {Promise<import("telegram").TelegramClient>} 返回已启动的 Telegram 客户端实例
 */
export async function startDispatcher() {
    console.log("🔄 正在启动 Dispatcher 组件...");

    // --- 🤖 Telegram 客户端多实例协调启动 ---
    let isClientActive = false;
    let isClientStarting = false; // 防止重入标志

    // 设置连接状态回调，当连接断开时重置 isClientActive
    setConnectionStatusCallback((isConnected) => {
        if (!isConnected && isClientActive) {
            console.log("🔌 Telegram 连接已断开，重置客户端状态");
            isClientActive = false;
        }
    });

    const startTelegramClient = async () => {
        // 防止重入：如果正在启动中，直接返回
        if (isClientStarting) {
            console.log("⏳ 客户端正在启动中，跳过本次重试...");
            return false;
        }

        // 尝试获取 Telegram 客户端专属锁 (增加 TTL 到 90s，减少因延迟导致的丢失)
        const hasLock = await instanceCoordinator.acquireLock("telegram_client", 90);
        if (!hasLock) {
            if (isClientActive) {
                console.warn("🚨 失去 Telegram 锁或无法续租，正在断开连接...");
                try {
                    // 强制断开，并设置较短的超时防止卡死在 disconnect
                    await Promise.race([
                        client.disconnect(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 5000))
                    ]);
                } catch (e) {
                    console.error("⚠️ 断开连接时出错:", e.message);
                }
                isClientActive = false;
            }
            return false;
        }

        if (isClientActive) return true; // 已启动且持有锁

        isClientStarting = true; // 标记开始启动
        console.log("👑 已获取 Telegram 锁，正在启动客户端...");

        let retryCount = 0;
        const maxRetries = 3;

        try {
            while (!isClientActive && retryCount < maxRetries) {
                try {
                    await client.start({ botAuthToken: config.botToken });
                    await saveSession();
                    console.log("🚀 Telegram 客户端已连接");
                    isClientActive = true;
                    isClientStarting = false;
                    return true;
                } catch (error) {
                    retryCount++;

                    if (error.code === 406 && error.errorMessage?.includes('AUTH_KEY_DUPLICATED')) {
                        console.warn(`⚠️ 检测到 AUTH_KEY_DUPLICATED 错误 (尝试 ${retryCount}/${maxRetries})，正在清除旧 Session 并重试...`);
                        if (retryCount < maxRetries) {
                            await clearSession();
                            resetClientSession();
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                    }

                    console.error(`❌ 启动 Telegram 客户端失败 (尝试 ${retryCount}/${maxRetries}):`, error.message);

                    // 如果不是 Auth Key 问题，增加一点延迟再重试，避免瞬间刷爆
                    if (retryCount < maxRetries) {
                        await new Promise(r => setTimeout(r, 3000));
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

    // 定期检查/续租锁
    setInterval(async () => {
        await startTelegramClient();
    }, 30000);

    // 4. 注册事件监听器 -> 交给 MessageHandler 处理
    // 初始化 MessageHandler (预加载 Bot ID)
    client.addEventHandler(async (event) => {
        await MessageHandler.handleEvent(event, client);
    });

    // 延迟初始化 Bot ID (等待连接建立)
    setTimeout(() => MessageHandler.init(client), 5000);

    console.log("🎉 Dispatcher 组件启动完成！");
    return client;
}