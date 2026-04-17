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

class DispatcherManager {
    constructor() {
        this.isClientActive = false;
        this.isClientStarting = false;
        this.connectionRetries = 0;
        this.MAX_CONNECTION_RETRIES = 5;
        this.loopCount = 0;
        this.maxRetries = 3;
    }

    handleConnectionStatusChange = (isConnected) => {
        log.debug(`🔌 Telegram 连接状态变化: ${isConnected ? '已连接' : '已断开'}`);
        if (!isConnected && this.isClientActive) {
            log.info("🔌 Telegram 连接已断开，重置客户端状态");
            this.isClientActive = false;
            
            // 自动尝试重新连接
            if (this.connectionRetries < this.MAX_CONNECTION_RETRIES) {
                this.connectionRetries++;
                log.info(`🔄 尝试重新连接 (${this.connectionRetries}/${this.MAX_CONNECTION_RETRIES})...`);
                setTimeout(() => this.startTelegramClient(), 3000);
            } else {
                log.error("🚨 达到最大重连次数，请检查网络连接");
            }
        }
    }

    handleUncaughtException = async (err) => {
        if (err.message.includes('Not connected')) {
            log.warn("⚠️ 捕获到 'Not connected' 错误，正在重置客户端状态");
            this.isClientActive = false;
            return;
        }
        log.error("🚨 未捕获的异常:", err);
    }

    async disconnectLostLockClient() {
        log.warn("🚨 失去 Telegram 锁，正在断开连接...");
        try {
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
        this.isClientActive = false;
    }

    async handleAuthKeyDuplicated(retryCount) {
        log.warn(`⚠️ 检测到 AUTH_KEY_DUPLICATED 错误 (尝试 ${retryCount}/${this.maxRetries})`);

        const stillHasLock = await instanceCoordinator.hasLock("telegram_client");
        if (!stillHasLock) {
            log.warn("🚨 在处理 AUTH_KEY_DUPLICATED 时失去锁，停止重试");
            this.isClientActive = false;
            this.isClientStarting = false;
            return false;
        }

        await resetClientSession();

        if (retryCount < this.maxRetries) {
            log.info("🔄 尝试重新连接（保持全局 Session 不变）...");
            if (process.env.NODE_ENV !== 'test') {
                await new Promise(r => setTimeout(r, 2000));
            }
            return 'continue';
        }

        log.warn("🚨 多次重试后仍然 AUTH_KEY_DUPLICATED，清除全局 Session");
        await clearSession();
        if (process.env.NODE_ENV !== 'test') {
            await new Promise(r => setTimeout(r, 2000));
        }
        return 'continue';
    }

    async tryConnectClient() {
        let retryCount = 0;
        while (!this.isClientActive && retryCount < this.maxRetries) {
            try {
                const config = getConfig();
                const client = await getClient();
                try {
                    await client.start({ botAuthToken: config.botToken });
                    await saveSession();
                    log.info("🚀 Telegram 客户端已连接");
                } catch (error) {
                    log.error("❌ Telegram 客户端连接失败", error);
                    throw error;
                }
                this.isClientActive = true;
                this.isClientStarting = false;
                return true;
            } catch (error) {
                retryCount++;

                if (error.code === 406 && error.errorMessage?.includes('AUTH_KEY_DUPLICATED')) {
                    const action = await this.handleAuthKeyDuplicated(retryCount);
                    if (action === false) return false;
                    if (action === 'continue') continue;
                }

                log.error(`❌ 启动 Telegram 客户端失败 (尝试 ${retryCount}/${this.maxRetries}):`, error.message);

                if (retryCount < this.maxRetries) {
                    if (process.env.NODE_ENV !== 'test') {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            }
        }
        return this.isClientActive;
    }

    startTelegramClient = async () => {
        const currentLoop = ++this.loopCount;
        log.debug(`[Loop ${currentLoop}] 🔄 开始执行 startTelegramClient...`);
        
        if (this.isClientStarting) {
            log.debug(`[Loop ${currentLoop}] ⏳ 客户端正在启动中，跳过本次重试...`);
            return false;
        }

        let alreadyHasLock = false;
        try {
            alreadyHasLock = await instanceCoordinator.hasLock("telegram_client");
        } catch (error) {
            log.error(`[Loop ${currentLoop}] 🔒 锁检查失败: ${error.message}`);
            return false;
        }
        
        const hasLock = await instanceCoordinator.acquireLock("telegram_client", 90, { maxAttempts: 5 });
        
        if (!hasLock) {
            if (this.isClientActive) {
                await this.disconnectLostLockClient();
            } else {
                log.debug("🔒 续租失败，客户端未激活");
            }
            return false;
        }

        if (this.isClientActive) {
            if (alreadyHasLock) {
                log.debug("🔒 静默续租成功");
            }
            return true;
        }

        this.isClientStarting = true;
        
        if (!alreadyHasLock) {
            log.info("👑 已获取 Telegram 锁，正在启动客户端...");
        } else {
            log.debug("🔒 续租成功，客户端已激活");
        }

        try {
            return await this.tryConnectClient();
        } finally {
            this.isClientStarting = false;
            log.debug(`[Loop ${currentLoop}] ✅ startTelegramClient 执行完毕`);
        }
    };

    startIntervalWithJitter = () => {
        const jitter = Math.random() * 20000 - 10000;
        const interval = 60000 + jitter;
        
        setTimeout(async () => {
            try {
                await this.startTelegramClient();
            } catch (error) {
                log.error(`🛡️ 后台循环错误已捕获，继续执行: ${error.message}`);
            } finally {
                this.startIntervalWithJitter();
            }
        }, interval);
    };

    async start() {
        setConnectionStatusCallback(this.handleConnectionStatusChange);

        if (typeof process !== 'undefined' && process.on) {
            process.on('uncaughtException', this.handleUncaughtException);
        }

        await this.startTelegramClient();

        if (process.env.NODE_ENV !== 'test') {
            this.startIntervalWithJitter();
        }

        const client = await getClient();
        client.addEventHandler(async (event) => {
            try {
                await MessageHandler.handleEvent(event, client);
            } catch (error) {
                log.error('Error handling Telegram event:', { error: error.message, stack: error.stack });
            }
        });

        setTimeout(() => MessageHandler.init(client), 5000);

        setTimeout(() => {
            startTelegramWatchdog();
            log.info("🐶 Telegram 看门狗已启动");
        }, 1000);

        return client;
    }
}

/**
 * 启动 Dispatcher 组件
 * @returns {Promise<import("telegram").TelegramClient>} 返回已启动的 Telegram 客户端实例
 */
export async function startDispatcher() {
    log.info("🔄 正在启动 Dispatcher 组件...");
    const manager = new DispatcherManager();
    return await manager.start();
}
