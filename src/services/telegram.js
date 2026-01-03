import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import logger, { enableTelegramConsoleProxy } from "./logger.js";
import { TelegramErrorClassifier } from "./telegram-error-classifier.js";

/**
 * 增强的电路断路器 - 支持错误类型感知
 */
class EnhancedTelegramCircuitBreaker {
    constructor() {
        this.state = 'CLOSED';
        this.failures = 0;
        this.lastFailure = null;
        this.threshold = 5;
        this.timeout = 60000;
        this.resetTimer = null;
        // 记录错误类型统计
        this.errorStats = {};
    }

    async execute(fn, errorType = null) {
        if (this.state === 'OPEN') {
            const timeSinceFailure = Date.now() - this.lastFailure;
            if (timeSinceFailure < this.timeout) {
                const waitTime = Math.ceil((this.timeout - timeSinceFailure) / 1000);
                throw new Error(`Circuit breaker OPEN. Wait ${waitTime}s more`);
            }
            this.state = 'HALF_OPEN';
            logger.info('🔄 Circuit breaker: HALF_OPEN state');
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure(errorType);
            throw error;
        }
    }

    onSuccess() {
        if (this.state === 'HALF_OPEN') {
            logger.info('✅ Circuit breaker: Connection restored');
        }
        this.state = 'CLOSED';
        this.failures = 0;
        this.errorStats = {};
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
    }

    onFailure(errorType) {
        this.failures++;
        this.lastFailure = Date.now();

        // 记录错误类型统计
        if (errorType) {
            this.errorStats[errorType] = (this.errorStats[errorType] || 0) + 1;
        }

        // 根据错误类型调整阈值
        const effectiveThreshold = this.getEffectiveThreshold(errorType);
        
        if (this.failures >= effectiveThreshold) {
            this.state = 'OPEN';
            logger.error(`🚨 Circuit breaker OPENED after ${this.failures} failures (threshold: ${effectiveThreshold}, type: ${errorType})`);
            
            // 根据错误类型调整超时时间
            const effectiveTimeout = this.getEffectiveTimeout(errorType);
            
            if (this.resetTimer) clearTimeout(this.resetTimer);
            this.resetTimer = setTimeout(() => {
                if (this.state === 'OPEN') {
                    this.state = 'HALF_OPEN';
                    logger.info('🔄 Circuit breaker: Attempting recovery');
                }
            }, effectiveTimeout);
        }
    }

    getEffectiveThreshold(errorType) {
        // 不同错误类型使用不同阈值
        const thresholds = {
            [TelegramErrorClassifier.ERROR_TYPES.TIMEOUT]: 5,
            [TelegramErrorClassifier.ERROR_TYPES.NETWORK]: 8,
            [TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED]: 6,
            [TelegramErrorClassifier.ERROR_TYPES.CONNECTION_LOST]: 4,
            [TelegramErrorClassifier.ERROR_TYPES.BINARY_READER]: 3,
            [TelegramErrorClassifier.ERROR_TYPES.AUTH_KEY_DUPLICATED]: 1,
            [TelegramErrorClassifier.ERROR_TYPES.RPC_ERROR]: 6,
            [TelegramErrorClassifier.ERROR_TYPES.UNKNOWN]: 5
        };
        return thresholds[errorType] || 5;
    }

    getEffectiveTimeout(errorType) {
        // 不同错误类型使用不同恢复时间
        const timeouts = {
            [TelegramErrorClassifier.ERROR_TYPES.TIMEOUT]: 90000,      // 90秒
            [TelegramErrorClassifier.ERROR_TYPES.NETWORK]: 120000,     // 2分钟
            [TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED]: 45000, // 45秒
            [TelegramErrorClassifier.ERROR_TYPES.CONNECTION_LOST]: 60000, // 1分钟
            [TelegramErrorClassifier.ERROR_TYPES.BINARY_READER]: 30000, // 30秒
            [TelegramErrorClassifier.ERROR_TYPES.AUTH_KEY_DUPLICATED]: 0, // 立即恢复（但需要特殊处理）
            [TelegramErrorClassifier.ERROR_TYPES.RPC_ERROR]: 50000,     // 50秒
            [TelegramErrorClassifier.ERROR_TYPES.UNKNOWN]: 60000       // 1分钟
        };
        return timeouts[errorType] || 60000;
    }

    getState() {
        return {
            state: this.state,
            failures: this.failures,
            lastFailure: this.lastFailure,
            timeSinceLastFailure: this.lastFailure ? Date.now() - this.lastFailure : null,
            errorStats: this.errorStats
        };
    }

    /**
     * 检查是否应该跳过重连（某些错误不需要立即重连）
     */
    shouldSkipReconnect(errorType) {
        return errorType === TelegramErrorClassifier.ERROR_TYPES.AUTH_KEY_DUPLICATED;
    }
}

const telegramCircuitBreaker = new EnhancedTelegramCircuitBreaker();

// 模块级状态变量
let telegramClient = null;
let isClientInitializing = false;
let lastUpdateTimestamp = Date.now();
let updateHealthMonitor = null;
let lastHeartbeat = Date.now();
let consecutiveFailures = 0;
let isReconnecting = false;
let connectionStatusCallback = null;
let watchdogTimer = null;
let reconnectTimeout = null;

// 错误类型跟踪
let lastErrorType = null;
let errorTypeFailures = {}; // 按错误类型记录失败次数

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
 * 清除保存的 Session 字符串
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
    const client = await getClient();
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
 * 重置客户端 Session 为空
 */
export const resetClientSession = async () => {
    try {
        const client = await getClient();
        if (client.connected) {
            logger.info("🔌 正在断开 Telegram 客户端连接...");
            await client.disconnect();
        }

        if (client._sender) {
            try {
                await client._sender.disconnect();
            } catch (e) {
                logger.warn("⚠️ 清理 GramJS _sender 失败:", e);
            }
            client._sender = undefined;
        }

        client.session = new StringSession("");
        logger.info("🔄 客户端内存 Session 已重置，准备重新连接...");
    } catch (e) {
        logger.error("❌ 重置内存 Session 失败:", e);
    }
};

/**
 * 初始化 Telegram 客户端（增强版）
 */
async function initTelegramClient() {
    if (telegramClient) {
        return telegramClient;
    }
    
    if (isClientInitializing) {
        return new Promise((resolve, reject) => {
            const checkInit = setInterval(() => {
                if (telegramClient) {
                    clearInterval(checkInit);
                    resolve(telegramClient);
                }
            }, 100);
            
            setTimeout(() => {
                clearInterval(checkInit);
                reject(new Error('Telegram client initialization timeout'));
            }, 30000);
        });
    }
    
    isClientInitializing = true;
    
    try {
        const proxyOptions = config.telegram?.proxy?.host ? {
            proxy: {
                ip: config.telegram.proxy.host,
                port: parseInt(config.telegram.proxy.port),
                socksType: config.telegram.proxy.type === 'socks5' ? 5 : 4,
                username: config.telegram.proxy.username,
                password: config.telegram.proxy.password,
            }
        } : {};
        
        const sessionString = await getSavedSession();
        
        // 增强配置：根据错误类型动态调整
        const clientConfig = {
            connectionRetries: 3,
            requestRetries: 3,
            retryDelay: { 
                min: 5000,
                max: 15000
            },
            timeout: 120000,
            connectionTimeout: 60000,
            socketTimeout: 90000,
            maxConcurrentDownloads: 2,
            connectionPoolSize: 3,
            updateGetIntervalMs: 15000,
            pingIntervalMs: 45000,
            keepAliveTimeout: 45000,
            floodSleepThreshold: 60,
            deviceModel: "DriveCollector-Server",
            systemVersion: "Linux",
            appVersion: "2.3.3",
            useWSS: false,
            autoReconnect: true,
            dcId: undefined,
            useIPv6: false,
            baseLogger: {
                levels: ["error", "warn", "info", "debug"],
                _logLevel: "info",
                canSend: function(level) {
                    return this._logLevel
                        ? this.levels.indexOf(this._logLevel) >= this.levels.indexOf(level)
                        : false;
                },
                setLevel: function(level) {
                    this._logLevel = level;
                },
                get logLevel() {
                    return this._logLevel;
                },
                info: logger.info.bind(logger),
                warn: logger.warn.bind(logger),
                error: (msg, ...args) => {
                    const msgStr = msg?.toString() || '';
                    if (msgStr.includes('TIMEOUT') || msgStr.includes('timeout') || msgStr.includes('ETIMEDOUT')) {
                        logger.error(`⚠️ Telegram timeout detected: ${msgStr}`, { service: 'telegram', ...args });
                        telegramCircuitBreaker.onFailure(TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                    } else {
                        logger.error(msg, ...args);
                    }
                },
                debug: logger.debug.bind(logger),
                raw: (level, msg, ...args) => {
                    if (level === 'error') {
                        logger.error(msg, ...args);
                    } else if (level === 'warn') {
                        logger.warn(msg, ...args);
                    } else {
                        logger.info(msg, ...args);
                    }
                }
            },
            ...proxyOptions
        };

        enableTelegramConsoleProxy();
        
        // 使用错误类型感知的电路断路器
        telegramClient = await telegramCircuitBreaker.execute(async () => {
            return new TelegramClient(
                new StringSession(sessionString),
                config.apiId,
                config.apiHash,
                clientConfig
            );
        }, TelegramErrorClassifier.ERROR_TYPES.UNKNOWN);
        
        setupEventListeners(telegramClient);
        
        return telegramClient;
    } finally {
        isClientInitializing = false;
    }
}

/**
 * 设置事件监听器（增强版）
 */
function setupEventListeners(client) {
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

    // 增强错误处理：使用错误分类器
    client.on("error", (err) => {
        const errorType = TelegramErrorClassifier.classify(err);
        lastErrorType = errorType;
        
        // 记录错误类型统计
        errorTypeFailures[errorType] = (errorTypeFailures[errorType] || 0) + 1;

        logger.error(`⚠️ Telegram error [${errorType}]: ${err.message}`, { service: 'telegram' });

        // 检查是否需要触发电路断路器
        if (TelegramErrorClassifier.shouldTripCircuitBreaker(errorType, errorTypeFailures[errorType])) {
            telegramCircuitBreaker.onFailure(errorType);
        }

        // 检查是否需要跳过重连
        if (TelegramErrorClassifier.shouldSkipReconnect(errorType)) {
            logger.warn(`⚠️ Error type ${errorType} requires special handling, skipping normal reconnection`);
            return;
        }

        // 获取推荐的重连策略
        const strategy = TelegramErrorClassifier.getReconnectStrategy(errorType, errorTypeFailures[errorType]);
        
        if (!strategy.shouldRetry) {
            logger.warn(`⚠️ Max retries exceeded for error type ${errorType}, stopping reconnection attempts`);
            return;
        }

        // 执行重连
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            const shouldFullReset = TelegramErrorClassifier.shouldResetSession(errorType, errorTypeFailures[errorType]);
            handleConnectionIssue(!shouldFullReset, errorType);
        }, strategy.delay);
    });

    // 更新循环健康监控
    let consecutiveUpdateTimeouts = 0;
    client.addEventHandler((update) => {
        lastUpdateTimestamp = Date.now();
        if (consecutiveFailures > 0) {
            consecutiveFailures = 0;
        }
        if (consecutiveUpdateTimeouts > 0) {
            consecutiveUpdateTimeouts = 0;
        }
    });

    client.on("connected", () => {
        if (updateHealthMonitor) clearInterval(updateHealthMonitor);
        
        updateHealthMonitor = setInterval(async () => {
            const timeSinceLastUpdate = Date.now() - lastUpdateTimestamp;
            
            if (timeSinceLastUpdate > 60000 && timeSinceLastUpdate <= 120000) {
                logger.warn(`⚠️ Update loop slow (no updates for ${Math.floor(timeSinceLastUpdate / 1000)}s)`);
                consecutiveUpdateTimeouts++;
                
                if (!isReconnecting) {
                    handleConnectionIssue(true, TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                }
            } else if (timeSinceLastUpdate > 120000) {
                logger.error(`🚨 Update loop STUCK (${Math.floor(timeSinceLastUpdate / 1000)}s), triggering full reset`, { service: 'telegram', duration: timeSinceLastUpdate });
                telegramCircuitBreaker.onFailure(TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                consecutiveUpdateTimeouts++;
                
                if (consecutiveUpdateTimeouts > 2) {
                    await resetClientSession();
                    await handleConnectionIssue(false, TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                    consecutiveUpdateTimeouts = 0;
                }
                
                lastUpdateTimestamp = Date.now();
            }
        }, 30000);
    });

    client.on("disconnected", () => {
        if (updateHealthMonitor) {
            clearInterval(updateHealthMonitor);
            updateHealthMonitor = null;
        }
    });
}

/**
 * 获取 Telegram 客户端实例
 */
export const getClient = async () => {
    return await initTelegramClient();
};

// 兼容性导出
export const client = new Proxy({}, {
    get: (target, prop) => {
        if (prop === 'connected') {
            return telegramClient?.connected || false;
        }
        if (prop === 'session') {
            return telegramClient?.session;
        }
        if (prop === 'on') {
            return (...args) => {
                if (telegramClient) {
                    return telegramClient.on(...args);
                }
                setTimeout(() => telegramClient?.on(...args), 100);
            };
        }
        if (telegramClient && typeof telegramClient[prop] === 'function') {
            return telegramClient[prop].bind(telegramClient);
        }
        return async (...args) => {
            const c = await getClient();
            if (typeof c[prop] === 'function') {
                return c[prop](...args);
            }
            throw new TypeError(`client.${prop.toString()} is not a function`);
        };
    }
});

export const isClientActive = async () => {
    const client = await getClient();
    return client.connected;
};

export const ensureConnected = async () => {
    const client = await getClient();
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
 * 处理连接异常情况（增强版）
 * @param {boolean} lightweight - 是否轻量重连
 * @param {string} errorType - 错误类型
 */
async function handleConnectionIssue(lightweight = false, errorType = TelegramErrorClassifier.ERROR_TYPES.UNKNOWN) {
    if (isReconnecting) {
        logger.debug("🔄 Reconnection already in progress, skipping duplicate");
        return;
    }
    
    // 检查电路断路器状态
    if (telegramCircuitBreaker.state === 'OPEN') {
        logger.warn("🚨 Circuit breaker is OPEN, blocking reconnection attempts");
        return;
    }
    
    // 检查锁所有权
    try {
        const hasLock = await instanceCoordinator.hasLock("telegram_client");
        if (!hasLock) {
            logger.warn("🚨 Lost lock ownership, cancelling reconnection");
            return;
        }
    } catch (e) {
        logger.warn(`⚠️ Lock check failed: ${e.message},暂缓重连`);
        return;
    }

    // 检查是否应该跳过重连
    if (TelegramErrorClassifier.shouldSkipReconnect(errorType)) {
        logger.warn(`⚠️ Skipping reconnection for error type: ${errorType}`);
        return;
    }

    isReconnecting = true;
    
    try {
        const client = await getClient();
        const strategy = TelegramErrorClassifier.getReconnectStrategy(errorType, errorTypeFailures[errorType] || 0);
        
        logger.info(`🔄 Starting reconnection [type=${errorType}, lightweight=${lightweight}, delay=${strategy.delay}ms]`);

        // 增强断开连接
        try {
            if (client.connected) {
                await Promise.race([
                    client.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 8000))
                ]);
                logger.info("✅ Client disconnected gracefully");
            }
        } catch (de) {
            logger.warn("⚠️ Disconnect timeout or error:", de.message);
        }

        // 清理发送器
        if (client._sender) {
            try {
                await Promise.race([
                    client._sender.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Sender disconnect timeout")), 5000))
                ]);
                client._sender = undefined;
                logger.info("✅ Sender state cleaned");
            } catch (e) {
                logger.warn("⚠️ Sender cleanup failed:", e.message);
                client._sender = undefined;
            }
        }

        // Session 管理
        const shouldReset = TelegramErrorClassifier.shouldResetSession(errorType, errorTypeFailures[errorType] || 0);
        if (!lightweight || shouldReset) {
            logger.info("🔄 Resetting session due to error type or strategy");
            await resetClientSession();
        } else {
            logger.info("🔄 Lightweight reconnection - preserving session");
        }

        // 等待策略延迟
        logger.info(`⏳ Reconnection backoff: ${Math.floor(strategy.delay / 1000)}s`);
        await new Promise(r => setTimeout(r, strategy.delay));

        // 使用电路断路器保护重连
        await telegramCircuitBreaker.execute(async () => {
            await client.connect();
            await client.start({ botAuthToken: config.botToken });
            await saveSession();
            
            logger.info("✅ Reconnection successful");
            lastHeartbeat = Date.now();
            consecutiveFailures = 0;
            
            // 验证连接健康
            const healthCheck = await client.getMe().catch(e => {
                logger.error("❌ Health check failed after reconnection:", e);
                throw e;
            });
            
            if (healthCheck) {
                logger.info("✅ Connection health verified");
                // 重置错误统计
                errorTypeFailures[errorType] = 0;
            }
        }, errorType);
        
    } catch (e) {
        logger.error("❌ Reconnection failed:", e);
        consecutiveFailures++;
        
        // 如果连续失败次数过多，触发电路断路器
        if (consecutiveFailures >= 3) {
            logger.error("🚨 Multiple reconnection failures, opening circuit breaker");
            telegramCircuitBreaker.onFailure(errorType);
        }
    } finally {
        isReconnecting = false;
    }
}

/**
 * 启动看门狗定时器（增强版）
 */
export const startWatchdog = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    
    watchdogTimer = setInterval(async () => {
        const now = Date.now();

        // 处理时间回拨
        if (lastHeartbeat > now) {
            logger.info(`🕒 检测到时间回拨，重置心跳时间: last=${lastHeartbeat}, now=${now}`);
            lastHeartbeat = now;
            isReconnecting = false;
            consecutiveFailures = 0;
        }

        if (isReconnecting) {
            return;
        }

        // 检查电路断路器状态
        const cbState = telegramCircuitBreaker.getState();
        if (cbState.state === 'OPEN') {
            const waitTime = Math.ceil((cbState.timeout - (now - cbState.lastFailure)) / 1000);
            logger.warn(`⏸️ Watchdog paused - circuit breaker OPEN (${waitTime}s remaining)`);
            return;
        }

        try {
            const client = await getClient();
            if (!client.connected) {
                consecutiveFailures++;
                logger.warn(`💔 Client disconnected, failure count: ${consecutiveFailures}`);
                
                if (now - lastHeartbeat >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                    logger.error(`🚨 Reconnection threshold reached, triggering recovery (failures=${consecutiveFailures})`);
                    handleConnectionIssue(true, TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED);
                }
                return;
            }

            // 增强健康检查
            await Promise.race([
                client.getMe(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Health check timeout")), 10000))
            ]);
            
            lastHeartbeat = Date.now();
            consecutiveFailures = 0;
            
        } catch (e) {
            consecutiveFailures++;

            // 特殊处理 AUTH_KEY_DUPLICATED
            if (e.code === 406 && e.errorMessage?.includes("AUTH_KEY_DUPLICATED")) {
                logger.error("🚨 检测到 AUTH_KEY_DUPLICATED，会话已在别处激活");
                lastHeartbeat = 0;
                try {
                    const client = await getClient();
                    await client.disconnect();
                } catch (disconnectError) {
                    logger.warn("⚠️ 断开连接时出错:", disconnectError);
                }
                await resetClientSession();
                await instanceCoordinator.releaseLock("telegram_client");
                return;
            }

            const errorType = TelegramErrorClassifier.classify(e);
            logger.warn(`💔 Heartbeat failed (${consecutiveFailures}/3): [${errorType}] ${e.message || e}`);

            const currentNow = Date.now();
            const diff = currentNow - lastHeartbeat;

            if (diff >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                logger.error(`🚨 Heartbeat threshold exceeded, triggering reconnection... (diff=${diff}, failures=${consecutiveFailures})`);
                handleConnectionIssue(true, errorType);
            }
        }
    }, 60 * 1000);
};

/**
 * 停止看门狗定时器
 */
export const stopWatchdog = () => {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
    if (updateHealthMonitor) {
        clearInterval(updateHealthMonitor);
        updateHealthMonitor = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    isReconnecting = false;
    lastHeartbeat = Date.now();
};

/**
 * 获取电路断路器状态
 */
export const getCircuitBreakerState = () => {
    return telegramCircuitBreaker.getState();
};

/**
 * 手动重置电路断路器
 */
export const resetCircuitBreaker = () => {
    telegramCircuitBreaker.state = 'CLOSED';
    telegramCircuitBreaker.failures = 0;
    telegramCircuitBreaker.lastFailure = null;
    telegramCircuitBreaker.errorStats = {};
    if (telegramCircuitBreaker.resetTimer) {
        clearTimeout(telegramCircuitBreaker.resetTimer);
        telegramCircuitBreaker.resetTimer = null;
    }
    errorTypeFailures = {};
    lastErrorType = null;
    logger.info("🔄 Circuit breaker manually reset");
};

/**
 * 获取更新循环健康状态
 */
export const getUpdateHealth = () => {
    return {
        lastUpdate: lastUpdateTimestamp,
        timeSince: Date.now() - lastUpdateTimestamp
    };
};

/**
 * 连接并启动 Telegram 客户端
 */
export const connectAndStart = async () => {
    try {
        const client = await getClient();
        
        if (!client.connected) {
            logger.info("🔌 正在连接 Telegram 客户端...");
            await client.connect();
            
            logger.info("🤖 正在启动 Telegram Bot...");
            await client.start({ botAuthToken: config.botToken });
            
            await saveSession();
            
            enableTelegramConsoleProxy();
            logger.info("✅ Telegram 控制台代理已启用");
        }
        
        return client;
    } catch (error) {
        logger.error("❌ Telegram 客户端连接启动失败:", error);
        throw error;
    }
};

/**
 * 重新连接 Telegram Bot (供外部调用)
 * @param {boolean} lightweight - 是否轻量重连
 */
export const reconnectBot = async (lightweight = true) => {
    await handleConnectionIssue(lightweight, TelegramErrorClassifier.ERROR_TYPES.UNKNOWN);
};

// 启动看门狗 (在测试环境下不自动启动)
if (process.env.NODE_ENV !== 'test') {
    startWatchdog();
}