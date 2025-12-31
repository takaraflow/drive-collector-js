import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import logger, { enableTelegramConsoleProxy } from "./logger.js";

// Circuit Breaker for Telegram Client
class TelegramCircuitBreaker {
    constructor() {
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.lastFailure = null;
        this.threshold = 5; // Open after 5 failures
        this.timeout = 60000; // 1 minute before attempting half-open
        this.resetTimer = null;
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            const timeSinceFailure = Date.now() - this.lastFailure;
            if (timeSinceFailure < this.timeout) {
                const waitTime = Math.ceil((this.timeout - timeSinceFailure) / 1000);
                throw new Error(`Circuit breaker OPEN. Wait ${waitTime}s more`);
            }
            // Transition to HALF_OPEN
            this.state = 'HALF_OPEN';
            logger.info('🔄 Circuit breaker: HALF_OPEN state');
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    onSuccess() {
        if (this.state === 'HALF_OPEN') {
            logger.info('✅ Circuit breaker: Connection restored');
        }
        this.state = 'CLOSED';
        this.failures = 0;
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
    }

    onFailure() {
        this.failures++;
        this.lastFailure = Date.now();

        if (this.failures >= this.threshold) {
            this.state = 'OPEN';
            logger.error(`🚨 Circuit breaker OPENED after ${this.failures} failures`);
            
            if (this.resetTimer) clearTimeout(this.resetTimer);
            this.resetTimer = setTimeout(() => {
                if (this.state === 'OPEN') {
                    this.state = 'HALF_OPEN';
                    logger.info('🔄 Circuit breaker: Attempting recovery');
                }
            }, this.timeout);
        }
    }

    getState() {
        return {
            state: this.state,
            failures: this.failures,
            lastFailure: this.lastFailure,
            timeSinceLastFailure: this.lastFailure ? Date.now() - this.lastFailure : null
        };
    }
}

const telegramCircuitBreaker = new TelegramCircuitBreaker();

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
 * 重置客户端 Session 为空（用于 AUTH_KEY_DUPLICATED 恢复）
 */
export const resetClientSession = async () => {
    try {
        const client = await getClient();
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

// Telegram 客户端初始化状态
let telegramClient = null;
let isClientInitializing = false;

/**
 * 初始化 Telegram 客户端（延迟初始化）
 */
async function initTelegramClient() {
    if (telegramClient) {
        return telegramClient;
    }
    
    if (isClientInitializing) {
        // 等待初始化完成
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
        
        // 延迟获取session
        const sessionString = await getSavedSession();
        
        // Enhanced configuration with optimized timeout and retry settings
        const clientConfig = {
            // Connection and retry configuration
            connectionRetries: 3, // Optimized: 3 retries to balance reliability and performance
            requestRetries: 3, // Optimized: 3 retries for API requests
            retryDelay: { 
                min: 5000,    // Minimum 5s delay between retries
                max: 15000    // Maximum 15s delay with exponential backoff
            },
            
            // Timeout configuration (increased for high-latency environments)
            timeout: 120000, // Global timeout: 120s for complete operation
            connectionTimeout: 60000, // Connection establishment: 60s
            socketTimeout: 90000,     // Socket read/write: 90s
            
            // Concurrency and resource limits
            maxConcurrentDownloads: 2, // Limit concurrent downloads for stability
            connectionPoolSize: 3,     // Connection pool size
            
            // Update loop optimization
            updateGetIntervalMs: 15000, // Poll updates every 15s (reduced frequency)
            pingIntervalMs: 45000,      // Ping every 45s to detect stale connections
            keepAliveTimeout: 45000,    // Keep-alive ping interval
            
            // Additional stability settings
            floodSleepThreshold: 60,
            deviceModel: "DriveCollector-Server",
            systemVersion: "Linux",
            appVersion: "2.3.3",
            useWSS: false,
            autoReconnect: true,
            dcId: undefined,
            useIPv6: false,
            
            // Enhanced logger with full coverage for timeout detection
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
                    // Enhanced error logging for timeout patterns
                    const msgStr = msg?.toString() || '';
                    if (msgStr.includes('TIMEOUT') || msgStr.includes('timeout') || msgStr.includes('ETIMEDOUT')) {
                        logger.error(`⚠️ Telegram timeout detected: ${msgStr}`, { service: 'telegram', ...args });
                        // Trigger circuit breaker
                        telegramCircuitBreaker.onFailure();
                    } else {
                        logger.error(msg, ...args);
                    }
                },
                debug: logger.debug.bind(logger),
                // NEW: Raw method for direct capture
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

        // Enable console proxy early to capture library errors
        enableTelegramConsoleProxy();
        
        // Use circuit breaker for client creation
        telegramClient = await telegramCircuitBreaker.execute(async () => {
            return new TelegramClient(
                new StringSession(sessionString),
                config.apiId,
                config.apiHash,
                clientConfig
            );
        });
        
        // 设置事件监听器
        setupEventListeners(telegramClient);
        
        return telegramClient;
    } finally {
        isClientInitializing = false;
    }
}

/**
 * 设置事件监听器
 */
function setupEventListeners(client) {
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

    // Enhanced error handling with timeout detection and circuit breaker
    client.on("error", (err) => {
        const errorMsg = err?.message || "";
        
        // Enhanced timeout detection
        const isTimeoutError =
            errorMsg.includes("TIMEOUT") ||
            errorMsg.includes("timeout") ||
            errorMsg.includes("timed out") ||
            errorMsg.includes("ETIMEDOUT") ||
            errorMsg.includes("ECONNRESET") ||
            (err.code === 'ETIMEDOUT');
        
        const isBinaryReaderError =
            errorMsg.includes("readUInt32LE") ||
            errorMsg.includes("readInt32LE") ||
            (err instanceof TypeError && errorMsg.includes("undefined"));
        
        const isConnectionError =
            errorMsg.includes("Not connected") ||
            errorMsg.includes("Connection closed") ||
            errorMsg.includes("RPCError");
        
        if (isTimeoutError) {
            logger.error(`⚠️ Telegram TIMEOUT error detected: ${errorMsg}`, { service: 'telegram' });
            telegramCircuitBreaker.onFailure();
            
            // Enhanced reconnection with exponential backoff
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            const backoffDelay = Math.min(1000 * Math.pow(2, telegramCircuitBreaker.failures), 30000);
            reconnectTimeout = setTimeout(() => handleConnectionIssue(true), backoffDelay);
            
        } else if (isConnectionError) {
            logger.warn(`⚠️ Telegram connection error: ${errorMsg}`, { service: 'telegram' });
            handleConnectionIssue(true);
            
        } else if (isBinaryReaderError) {
            logger.error(`⚠️ Telegram BinaryReader error: ${errorMsg}`, { service: 'telegram' });
            telegramCircuitBreaker.onFailure();
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(() => handleConnectionIssue(true), 2000);
            
        } else {
            logger.error("❌ Telegram client error:", { service: 'telegram', error: err });
        }
    });

    // NEW: Add update loop health monitoring with enhanced thresholds
    // Use module-level lastUpdateTimestamp instead of local variable
    let updateHealthMonitor = null;
    let consecutiveUpdateTimeouts = 0; // Track consecutive update timeouts

    // Track update timestamps to detect stuck update loops
    client.addEventHandler((update) => {
        lastUpdateTimestamp = Date.now();
        // Reset consecutive failures on successful update
        if (consecutiveFailures > 0) {
            consecutiveFailures = 0;
        }
        // Reset update timeout counter on any update
        if (consecutiveUpdateTimeouts > 0) {
            consecutiveUpdateTimeouts = 0;
        }
    });

    // Start health monitor when connected
    client.on("connected", () => {
        if (updateHealthMonitor) clearInterval(updateHealthMonitor);
        
        updateHealthMonitor = setInterval(async () => {
            const timeSinceLastUpdate = Date.now() - lastUpdateTimestamp;
            
            // If no updates for 60 seconds, warn
            if (timeSinceLastUpdate > 60000 && timeSinceLastUpdate <= 120000) {
                logger.warn(`⚠️ Update loop slow (no updates for ${Math.floor(timeSinceLastUpdate / 1000)}s)`);
                consecutiveUpdateTimeouts++;
                
                if (!isReconnecting) {
                    handleConnectionIssue(true); // Lightweight reconnection
                }
            }
            // If no updates for 120 seconds, consider update loop stuck and reset
            else if (timeSinceLastUpdate > 120000) {
                logger.error(`🚨 Update loop STUCK (${Math.floor(timeSinceLastUpdate / 1000)}s), triggering full reset`, { service: 'telegram', duration: timeSinceLastUpdate });
                telegramCircuitBreaker.onFailure();
                consecutiveUpdateTimeouts++;
                
                if (consecutiveUpdateTimeouts > 2) {
                    await resetClientSession(); // Reset session
                    await handleConnectionIssue(false); // Full reconnection
                    consecutiveUpdateTimeouts = 0;
                }
                
                // Reset timestamp to prevent repeated triggers
                lastUpdateTimestamp = Date.now();
            }
        }, 30000); // Check every 30 seconds
    });

    client.on("disconnected", () => {
        if (updateHealthMonitor) {
            clearInterval(updateHealthMonitor);
            updateHealthMonitor = null;
        }
    });
}

/**
 * 获取 Telegram 客户端实例（延迟初始化）
 */
export const getClient = async () => {
    return await initTelegramClient();
};

// 兼容性导出：保留原有的 client 导出指向（用于测试向后兼容）
export const client = {
    get connected() {
        // 同步属性访问，返回当前客户端的连接状态（如果已初始化）
        return telegramClient?.connected || false;
    },
    // 其他常用属性的代理
    get session() {
        return telegramClient?.session;
    },
    on: (...args) => {
        // 如果客户端已初始化，代理事件监听器
        if (telegramClient) {
            return telegramClient.on(...args);
        }
        // 否则延迟到初始化后设置
        const setupListener = () => {
            if (telegramClient) {
                telegramClient.on(...args);
            }
        };
        // 简单的延迟设置
        setTimeout(setupListener, 100);
    }
};

/**
 * 获取客户端活跃状态
 */
export const isClientActive = async () => {
    const client = await getClient();
    return client.connected;
};

/**
 * 确保客户端已连接，如果未连接则等待连接建立
 */
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

// --- 🛡️ 客户端监控与健康检查 (Watchdog) ---
let lastHeartbeat = Date.now();
let consecutiveFailures = 0;
let isReconnecting = false;
let connectionStatusCallback = null; // 连接状态变化回调
let watchdogTimer = null;
let reconnectTimeout = null;

/**
 * 重新连接 Telegram Bot (供外部调用)
 * @param {boolean} lightweight - 是否轻量重连
 */
export const reconnectBot = async (lightweight = true) => {
    await handleConnectionIssue(lightweight);
};

/**
 * 设置连接状态变化回调
 * @param {function} callback - 当连接状态变化时调用的函数，参数：(isConnected: boolean)
 */
export const setConnectionStatusCallback = (callback) => {
    connectionStatusCallback = callback;
};



/**
 * 处理连接异常情况
 */
async function handleConnectionIssue(lightweight = false) {
    if (isReconnecting) {
        logger.debug("🔄 Reconnection already in progress, skipping duplicate");
        return;
    }
    
    // Check circuit breaker state
    if (telegramCircuitBreaker.state === 'OPEN') {
        logger.warn("🚨 Circuit breaker is OPEN, blocking reconnection attempts");
        return;
    }
    
    // Verify lock ownership
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

    isReconnecting = true;
    
    try {
        const client = await getClient();
        logger.info(`🔄 Starting enhanced reconnection sequence [lightweight=${lightweight}]`);
        
        // Enhanced disconnection with timeout
        try {
            if (client.connected) {
                await Promise.race([
                    client.disconnect(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Disconnect Timeout")), 8000)
                    )
                ]);
                logger.info("✅ Client disconnected gracefully");
            }
        } catch (de) {
            logger.warn("⚠️ Disconnect timeout or error:", de.message);
        }

        // Enhanced sender cleanup
        if (client._sender) {
            try {
                await Promise.race([
                    client._sender.disconnect(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Sender disconnect timeout")), 5000)
                    )
                ]);
                client._sender = undefined;
                logger.info("✅ Sender state cleaned");
            } catch (e) {
                logger.warn("⚠️ Sender cleanup failed:", e.message);
                client._sender = undefined;
            }
        }

        // Session management
        if (!lightweight) {
            logger.info("🔄 Full reconnection - resetting session");
            await resetClientSession();
        } else {
            logger.info("🔄 Lightweight reconnection - preserving session");
        }

        // Exponential backoff with jitter
        const baseDelay = 5000 + (telegramCircuitBreaker.failures * 5000); // Increased multiplier for more aggressive backoff
        const jitter = Math.random() * 2000;
        const backoffTime = Math.min(baseDelay + jitter, 60000); // Increased max to 60s
        
        logger.info(`⏳ Reconnection backoff: ${Math.floor(backoffTime / 1000)}s`);
        await new Promise(r => setTimeout(r, backoffTime));

        // Reconnect with circuit breaker protection
        await telegramCircuitBreaker.execute(async () => {
            await client.connect();
            await client.start({ botAuthToken: config.botToken });
            await saveSession();
            
            logger.info("✅ Enhanced reconnection successful");
            lastHeartbeat = Date.now();
            consecutiveFailures = 0;
            
            // Verify connection health
            const healthCheck = await client.getMe().catch(e => {
                logger.error("❌ Health check failed after reconnection:", e);
                throw e;
            });
            
            if (healthCheck) {
                logger.info("✅ Connection health verified");
            }
        });
        
    } catch (e) {
        logger.error("❌ Enhanced reconnection failed:", e);
        consecutiveFailures++;
        
        // Force circuit breaker open if too many failures
        if (consecutiveFailures >= 3) {
            logger.error("🚨 Multiple reconnection failures, opening circuit breaker");
            telegramCircuitBreaker.onFailure();
        }
    } finally {
        isReconnecting = false;
    }
}

/**
 * 启动看门狗定时器
 */
export const startWatchdog = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    
    // 定时检查心跳（通过获取自身信息）
    watchdogTimer = setInterval(async () => {
        const now = Date.now();

        // 处理时间回拨（如测试环境重置时间或系统时钟同步）
        if (lastHeartbeat > now) {
            logger.info(`🕒 检测到时间回拨，重置心跳时间: last=${lastHeartbeat}, now=${now}`);
            lastHeartbeat = now;
            isReconnecting = false;
            consecutiveFailures = 0;
        }

        if (isReconnecting) {
            return;
        }

        // Check circuit breaker state
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
                
                // 如果已断开连接且超过 5 分钟没有恢复，或连续失败 3 次，触发强制重连
                if (now - lastHeartbeat >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                    logger.error(`🚨 Reconnection threshold reached, triggering recovery (failures=${consecutiveFailures})`);
                    handleConnectionIssue(true);
                }
                return;
            }

            // Enhanced health check with timeout
            await Promise.race([
                client.getMe(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Health check timeout")), 10000)
                )
            ]);
            
            lastHeartbeat = Date.now();
            consecutiveFailures = 0; // 成功后重置
            
        } catch (e) {
            consecutiveFailures++;

            // Special handling for AUTH_KEY_DUPLICATED
            if (e.code === 406 && e.errorMessage?.includes("AUTH_KEY_DUPLICATED")) {
                logger.error("🚨 检测到 AUTH_KEY_DUPLICATED，会话已在别处激活，本实例应停止连接");
                // 标记需要重置，并释放本地状态
                lastHeartbeat = 0; // 触发强制处理
                // 主动断开连接
                try {
                    const client = await getClient();
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

            logger.warn(`💔 Heartbeat failed (${consecutiveFailures}/3): ${e.message || e}`);

            // 使用当前时间再次检查差值，因为 await getMe() 可能经过了时间
            const currentNow = Date.now();
            const diff = currentNow - lastHeartbeat;

            if (diff >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                logger.error(`🚨 Heartbeat threshold exceeded, triggering reconnection... (diff=${diff}, failures=${consecutiveFailures})`);
                handleConnectionIssue(true);
            }
        }
    }, 60 * 1000); // 每 60 秒检查一次（更频繁的监控）
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
 * 获取电路断路器状态（用于监控和调试）
 */
export const getCircuitBreakerState = () => {
    return telegramCircuitBreaker.getState();
};

/**
 * 手动重置电路断路器（用于维护操作）
 */
export const resetCircuitBreaker = () => {
    telegramCircuitBreaker.state = 'CLOSED';
    telegramCircuitBreaker.failures = 0;
    telegramCircuitBreaker.lastFailure = null;
    if (telegramCircuitBreaker.resetTimer) {
        clearTimeout(telegramCircuitBreaker.resetTimer);
        telegramCircuitBreaker.resetTimer = null;
    }
    logger.info("🔄 Circuit breaker manually reset");
};

/**
 * 获取更新循环健康状态（用于监控）
 */
export const getUpdateHealth = () => {
    // Access the lastUpdateTimestamp from the module scope
    // This will be updated by the event handler in setupEventListeners
    return {
        lastUpdate: lastUpdateTimestamp,
        timeSince: Date.now() - lastUpdateTimestamp
    };
};

// Module-level variable to track update health (exposed from setupEventListeners)
let lastUpdateTimestamp = Date.now();

/**
 * 连接并启动 Telegram 客户端，同时启用控制台代理
 */
export const connectAndStart = async () => {
    try {
        const client = await getClient();
        
        if (!client.connected) {
            logger.info("🔌 正在连接 Telegram 客户端...");
            await client.connect();
            
            logger.info("🤖 正在启动 Telegram Bot...");
            await client.start({ botAuthToken: config.botToken });
            
            // 保存 session
            await saveSession();
            
            // 在 client.start() 后调用 enableTelegramConsoleProxy()
            enableTelegramConsoleProxy();
            logger.info("✅ Telegram 控制台代理已启用");
        }
        
        return client;
    } catch (error) {
        logger.error("❌ Telegram 客户端连接启动失败:", error);
        throw error;
    }
};

// 启动看门狗 (在测试环境下不自动启动，除非显式调用)
if (process.env.NODE_ENV !== 'test') {
    startWatchdog();
}