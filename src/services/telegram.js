import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getConfig } from "../config/index.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import logger, { enableTelegramConsoleProxy } from "./logger/index.js";
import { TelegramErrorClassifier } from "./telegram-error-classifier.js";

const log = logger.withModule ? logger.withModule('TelegramService') : logger;

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
            log.info('🔄 电路断路器: 进入 HALF_OPEN 状态');
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure(errorType, error);
            throw error;
        }
    }

    onSuccess() {
        if (this.state === 'HALF_OPEN') {
            log.info('✅ 电路断路器: 连接已恢复');
        }
        this.state = 'CLOSED';
        this.failures = 0;
        this.errorStats = {};
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
    }

    onFailure(errorType, error = null) {
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
            
             // 根据错误类型调整超时时间
             const effectiveTimeout = this.getEffectiveTimeout(errorType, error);

            // 如果是 Flood 错误，打印特殊日志
            if (errorType === TelegramErrorClassifier.ERROR_TYPES.FLOOD) {
                 log.error(`🚨 电路断路器开启 (原因: FLOOD 限制)。停止请求 ${Math.ceil(effectiveTimeout / 1000)} 秒。`);
            } else {
                log.error(`🚨 电路断路器开启 (失败次数: ${this.failures}, 阈值: ${effectiveThreshold}, 类型: ${errorType})`);
            }
            
            if (this.resetTimer) clearTimeout(this.resetTimer);
            this.resetTimer = setTimeout(() => {
                if (this.state === 'OPEN') {
                    this.state = 'HALF_OPEN';
                    log.info('🔄 电路断路器: 正在尝试恢复');
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
            [TelegramErrorClassifier.ERROR_TYPES.FLOOD]: 1,
            [TelegramErrorClassifier.ERROR_TYPES.RPC_ERROR]: 6,
            [TelegramErrorClassifier.ERROR_TYPES.UNKNOWN]: 5
        };
        return thresholds[errorType] || 5;
    }

    getEffectiveTimeout(errorType, error = null) {
        // Flood 错误特殊处理：使用 error.seconds
        if (errorType === TelegramErrorClassifier.ERROR_TYPES.FLOOD && error?.seconds) {
            return (error.seconds + 5) * 1000;
        }

        // 不同错误类型使用不同恢复时间
        const timeouts = {
            [TelegramErrorClassifier.ERROR_TYPES.TIMEOUT]: 90000,      // 90秒
            [TelegramErrorClassifier.ERROR_TYPES.NETWORK]: 120000,     // 2分钟
            [TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED]: 45000, // 45秒
            [TelegramErrorClassifier.ERROR_TYPES.CONNECTION_LOST]: 60000, // 1分钟
            [TelegramErrorClassifier.ERROR_TYPES.BINARY_READER]: 30000, // 30秒
            [TelegramErrorClassifier.ERROR_TYPES.AUTH_KEY_DUPLICATED]: 0, // 立即恢复（但需要特殊处理）
            [TelegramErrorClassifier.ERROR_TYPES.FLOOD]: 60000, // 默认 1 分钟（如果有具体 seconds 会被上面覆盖）
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

const TELEGRAM_CLIENT_LOCK = "telegram_client";

// 模块级状态变量
let telegramClient = null;
let isClientInitializing = false;
let lastUpdateTimestamp = Date.now();
let updateHealthMonitor = null;
let lastHeartbeat = Date.now();
let consecutiveFailures = 0;
let isReconnecting = false;
// 记录重连开始时间;用于检测"重连卡死"(isReconnecting 被永久锁死)并强制解锁自愈。
let reconnectStartedAt = 0;
let connectionStatusCallback = null;
let watchdogTimer = null;
let reconnectTimeout = null;

// 重连各网络步骤的超时上限。任何一步(connect/start/getMe 等)若无超时挂起,
// 会导致 handleConnectionIssue 的 finally 永远执行不到、isReconnecting 被永久锁死,
// 使看门狗与所有后续重连彻底失效(线上曾因此 6.5 小时无法自愈)。
const RECONNECT_STEP_TIMEOUT_MS = 90000;
const RECONNECT_HEALTHCHECK_TIMEOUT_MS = 15000;
// isReconnecting 被视为"卡死"的上限;超过则由看门狗强制解锁,兜底任何未预料的挂起。
const MAX_RECONNECT_STUCK_MS = 5 * 60 * 1000;

// gramjs 的 _borrowExportedSender catch 块在下载途中断线时会无退避、无上限地原地递归
// (node_modules/telegram/.../telegramBaseClient.js:284-290),每秒数千次同步 console.error,
// 把 Node 事件循环的定时器阶段饿死 → 心跳/看门狗/锁续租(300s TTL)/自愈重连全排不进队,进程瘫成活死人。
// gramjs 那段 catch 会先查 client._errorHandler,若已设置则先 await 它 —— 我们挂一个钩子,
// 在钩子里 await sleep(退避):这一次 await 就让出定时器阶段,microtask 死循环当场被打断,
// 定时器得以运行、自愈机器复活。这是掐洪流的命门(纯 src 注入,不碰 node_modules)。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FLOOD_BACKOFF_BASE_MS = 250;
const FLOOD_BACKOFF_MAX_MS = 5000;
const FLOOD_RESET_AFTER_MS = 30000;      // 静默超过此值则重置连续计数
const FLOOD_LOG_THROTTLE_MS = 5000;      // 结构化日志最多每 5s 一条,不给洪流添柴
const FLOOD_RECOVERY_THROTTLE_MS = 10000; // 触发主连接重连最多每 10s 一次
const floodState = {
    consecutive: 0,
    lastErrorAt: 0,
    lastLogAt: 0,
    lastRecoveryAt: 0,
    suppressed: 0,
};

/**
 * 纯函数:按连续错误次数计算退避毫秒(指数增长,上限 clamp)。
 * 命门在于返回值 > 0 —— 钩子里 await 它就让出事件循环定时器阶段。导出以便单元测试。
 */
export function computeFloodBackoff(consecutive) {
    const n = Math.max(0, consecutive - 1);
    return Math.min(FLOOD_BACKOFF_BASE_MS * 2 ** Math.min(n, 5), FLOOD_BACKOFF_MAX_MS);
}

/**
 * gramjs 客户端级错误钩子(挂到 client.onError → _errorHandler)。
 * 命门是末尾的 await sleep(backoff):让出事件循环定时器阶段,打断 gramjs 内部无退避的 microtask 递归洪流。
 * 导出以便单元测试。
 * @param {Error} err gramjs 抛出的错误
 */
export async function handleTelegramClientError(err) {
    const now = Date.now();
    if (now - floodState.lastErrorAt > FLOOD_RESET_AFTER_MS) {
        floodState.consecutive = 0;
        floodState.suppressed = 0;
    }
    floodState.consecutive += 1;
    floodState.lastErrorAt = now;

    const errorType = TelegramErrorClassifier.classify(err);

    if (now - floodState.lastLogAt >= FLOOD_LOG_THROTTLE_MS) {
        log.warn(
            `🌊 拦截 gramjs 导出连接错误洪流 [类型=${errorType}, 连续=${floodState.consecutive}, 期间抑制=${floodState.suppressed}]: ${(err?.message || "").slice(0, 200)}`,
            { service: "telegram" }
        );
        floodState.lastLogAt = now;
        floodState.suppressed = 0;
    } else {
        floodState.suppressed += 1;
    }

    // 限频触发主连接重连;handleConnectionIssue 自身按 isReconnecting/锁/断路器去重,
    // 门禁 !isReconnecting && !isClientInitializing 避免干扰正在进行的合法重连/初始化。
    if (
        now - floodState.lastRecoveryAt >= FLOOD_RECOVERY_THROTTLE_MS &&
        !isReconnecting &&
        !isClientInitializing
    ) {
        floodState.lastRecoveryAt = now;
        setImmediate(() => {
            handleConnectionIssue(true, errorType).catch((e) => {
                log.error("❌ onError 恢复触发失败:", { error: e?.message });
            });
        });
    }

    // 命门:await 一个 setTimeout,让出定时器阶段,打断纯 microtask 递归洪流。
    await sleep(computeFloodBackoff(floodState.consecutive));
}


const TEST_MODE_DC_CONFIG = {
    dcId: 2,
    serverIp: "149.154.167.40",
    serverPort: 443
};

let telegramDcConfig = null;
let telegramDcConfigLogged = false;

// 错误类型跟踪
let lastErrorType = null;
let errorTypeFailures = {}; // 按错误类型记录失败次数

function resolveTelegramDcConfig(config) {
    const serverDc = Number.isFinite(config.telegram?.serverDc) ? config.telegram.serverDc : null;
    const serverIp = config.telegram?.serverIp || null;
    const serverPort = Number.isFinite(config.telegram?.serverPort) ? config.telegram.serverPort : null;
    const customServerConfigured = serverDc !== null && serverIp && serverPort !== null;
    const hasAnyCustom = serverDc !== null || Boolean(serverIp) || serverPort !== null;
    const testMode = Boolean(config.telegram?.testMode);

    if (customServerConfigured) {
        return {
            testMode,
            customServerConfigured,
            hasAnyCustom,
            mode: "custom",
            dcId: serverDc,
            serverIp,
            serverPort
        };
    }

    if (testMode) {
        return {
            testMode,
            customServerConfigured,
            hasAnyCustom,
            mode: "test-default",
            ...TEST_MODE_DC_CONFIG
        };
    }

    return {
        testMode,
        customServerConfigured,
        hasAnyCustom,
        mode: "default",
        dcId: null,
        serverIp: null,
        serverPort: null
    };
}

function getTelegramDcConfig(config) {
    if (telegramDcConfig) {
        return telegramDcConfig;
    }
    telegramDcConfig = resolveTelegramDcConfig(config);
    return telegramDcConfig;
}

function logTelegramDcConfig(dcConfig) {
    if (telegramDcConfigLogged) {
        return;
    }
    telegramDcConfigLogged = true;
    const customServerUsed = dcConfig.mode === "custom";
    log.info(`✈️ Telegram DC 配置: testMode=${dcConfig.testMode}, customServer=${customServerUsed}, source=${dcConfig.mode}`);
    if (!customServerUsed && dcConfig.hasAnyCustom) {
        log.warn("⚠️ Telegram DC 配置不完整 (TG_SERVER_DC/IP/PORT); 忽略自定义 DC 覆盖");
    }
}

function applyTelegramDcConfig(client, config) {
    const dcConfig = getTelegramDcConfig(config);
    logTelegramDcConfig(dcConfig);
    if (dcConfig.mode === "default") {
        return;
    }
    client.session.setDC(dcConfig.dcId, dcConfig.serverIp, dcConfig.serverPort);
}

/**
 * 输出当前客户端的 DC 信息
 * 同时显示期望的 DC（根据配置）和实际的 DC（实际连接的）
 */
async function logCurrentDCInfo(client, config) {
    try {
        // 获取期望的 DC 配置
        const dcConfig = getTelegramDcConfig(config);
        const expectedDC = dcConfig.mode === "default" ? null : {
            id: dcConfig.dcId,
            ipAddress: dcConfig.serverIp,
            port: dcConfig.serverPort
        };
        
        // 获取实际的 DC 信息
        const actualDC = await client.getDC();
        
        if (expectedDC) {
            log.info(`📡 DC 信息 - 实际: DC ${actualDC.id} @ ${actualDC.ipAddress}:${actualDC.port} | 期望: DC ${expectedDC.id} @ ${expectedDC.ipAddress}:${expectedDC.port}`);
        } else {
            log.info(`📡 DC 信息 - 实际: DC ${actualDC.id} @ ${actualDC.ipAddress}:${actualDC.port}`);
        }
    } catch (e) {
        // 即使无法获取实际 DC，也要显示期望的 DC 配置
        const dcConfig = getTelegramDcConfig(config);
        const expectedDC = dcConfig.mode === "default" ? null : {
            id: dcConfig.dcId,
            ipAddress: dcConfig.serverIp,
            port: dcConfig.serverPort
        };
        
        if (expectedDC) {
            log.warn(`⚠️ 无法获取实际 DC 信息: ${e.message} | 期望: DC ${expectedDC.id} @ ${expectedDC.ipAddress}:${expectedDC.port}`);
        } else {
            log.warn(`⚠️ 无法获取 DC 信息: ${e.message}`);
        }
    }
}

/**
 * 获取当前 DC 信息（供外部调用）
 * 同时返回期望的 DC 和实际的 DC
 */
export async function getCurrentDCInfo() {
    if (!telegramClient) {
        return null;
    }
    try {
        const config = getConfig();
        const dcConfig = getTelegramDcConfig(config);
        
        const expectedDC = dcConfig.mode === "default" ? null : {
            id: dcConfig.dcId,
            ipAddress: dcConfig.serverIp,
            port: dcConfig.serverPort
        };
        
        const actualDC = await telegramClient.getDC();
        
        return {
            expected: expectedDC,
            actual: {
                dcId: actualDC.id,
                serverAddress: actualDC.ipAddress,
                port: actualDC.port
            }
        };
    } catch (e) {
        return null;
    }
}

export function resetTelegramDcConfig() {
    telegramDcConfig = null;
    telegramDcConfigLogged = false;
    telegramClient = null;
    isClientInitializing = false;
}

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
            log.info("🗑️ 仅清除本地 Session，不修改全局设置");
            return;
        }
        await SettingsRepository.set("tg_bot_session", "");
        log.info("🗑️ Telegram 全局 Session 已清除");
    } catch (e) {
        log.error("❌ 清除 Session 失败:", e);
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
            log.info("💾 Telegram Session 已持久化");
        }
    } catch (e) {
        log.error("❌ 保存 Session 失败:", e);
    }
};

/**
 * 重置客户端 Session 为空
 */
export const resetClientSession = async () => {
    try {
        const client = await getClient();
        if (client.connected) {
            log.info("🔌 正在断开 Telegram 客户端连接...");
            await client.disconnect();
        }

        if (client._sender) {
            try {
                await client._sender.disconnect();
            } catch (e) {
                log.warn("⚠️ 清理 GramJS _sender 失败:", e);
            }
            client._sender = undefined;
        }

        client.session = new StringSession("");
        log.info("🔄 客户端内存 Session 已重置，准备重新连接...");
    } catch (e) {
        log.error("❌ 重置内存 Session 失败:", e);
    }
};

function buildProxyOptions(config) {
    return config.telegram?.proxy?.host ? {
        proxy: {
            ip: config.telegram.proxy.host,
            port: parseInt(config.telegram.proxy.port),
            socksType: config.telegram.proxy.type === 'socks5' ? 5 : (config.telegram.proxy.type === 'socks4' ? 4 : 5),
            username: config.telegram.proxy.username || undefined,
            password: config.telegram.proxy.password || undefined,
        }
    } : {};
}

const resetWatchdogFailureState = () => {
    consecutiveFailures = 0;
    lastHeartbeat = Date.now();
    isReconnecting = false;
    reconnectStartedAt = 0;
};

/**
 * 给可能挂起的 Promise 套一个超时上限:超时则 reject(而非静默),
 * 让调用方的 catch/finally 一定能执行到,避免 isReconnecting 被永久锁死。
 * 仅用于重连握手类操作(connect/start/getMe),与文件下载无关、不随文件大小变化。
 * 导出以便单元测试。
 */
export function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${Math.floor(ms / 1000)}s`)), ms);
    });
    timer?.unref?.();
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 纯函数:判断一次重连是否已"卡死"(isReconnecting 长时间未复位)。
 * 作为兜底,即使某个未被 withTimeout 包裹的 await 挂起,看门狗也能强制解锁自愈。
 * 导出以便单元测试。
 */
export function isReconnectStuck(now, startedAt, maxMs) {
    return startedAt > 0 && now - startedAt > maxMs;
}

const stopLocalClientIfPresent = async (reason) => {
    if (!telegramClient) return;

    if (telegramClient.connected) {
        log.debug(`🔒 ${reason}; disconnecting local Telegram client`);
        try {
            if (telegramClient._sender) {
                await telegramClient._sender.disconnect().catch(() => {});
            }
            await telegramClient.disconnect();
        } catch (error) {
            log.debug(`🔒 Local Telegram client disconnect skipped: ${error.message || error}`);
        }
    }

    telegramClient = null;
    isClientInitializing = false;
};

export const stopTelegramClientRuntime = async (reason = 'telegram runtime stop') => {
    stopWatchdog();
    await stopLocalClientIfPresent(reason);
    resetWatchdogFailureState();
    try {
        if (await hasTelegramClientLock({ logContention: false })) {
            await instanceCoordinator.releaseLock(TELEGRAM_CLIENT_LOCK);
        }
    } catch (error) {
        log.warn(`⚠️ 释放 Telegram 锁失败: ${error.message || error}`);
    }
};

export const hasTelegramClientLock = async (options = {}) => {
    return instanceCoordinator.hasLock(TELEGRAM_CLIENT_LOCK, options);
};

function resolveTelegramLogLevel() {
    if (typeof log.canSend !== 'function') return 'info';
    for (const level of ['debug', 'info', 'warn', 'error']) {
        if (log.canSend(level)) return level;
    }
    return 'error';
}

function buildClientConfig(config, proxyOptions) {
    return {
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
        floodSleepThreshold: 300,
        deviceModel: config.telegram?.deviceModel || "DriveCollector-Server",
        systemVersion: config.telegram?.systemVersion || "Linux",
        appVersion: config.telegram?.appVersion || "2.3.3",
        useWSS: false,
        autoReconnect: true,
        dcId: undefined,
        useIPv6: false,
        baseLogger: {
            levels: ["error", "warn", "info", "debug"],
            _logLevel: resolveTelegramLogLevel(),
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
            info: log.info.bind(log),
            warn: log.warn.bind(log),
            error: (msg, ...args) => {
                const msgStr = msg?.toString() || '';
                const isTimeout = msgStr.includes('TIMEOUT') || msgStr.includes('timeout') || msgStr.includes('ETIMEDOUT');
                const isNotConnected = msgStr.includes('Not connected');

                if (isTimeout) {
                    log.error(`⚠️ 检测到 Telegram 超时: ${msgStr}`, { service: 'telegram', ...args });
                    telegramCircuitBreaker.onFailure(TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                } else if (isNotConnected) {
                    log.warn(`⚠️ Telegram 连接警告: ${msgStr}`, { service: 'telegram', ...args });
                    telegramCircuitBreaker.onFailure(TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED);
                } else {
                    log.error(msg, ...args);
                }

                if (!isClientInitializing && !isReconnecting && (isTimeout || isNotConnected)) {
                    const errorType = isTimeout ? TelegramErrorClassifier.ERROR_TYPES.TIMEOUT : TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED;
                    log.info(`🔄 在日志中检测到 ${errorType}，正在安排立即恢复检查...`);
                    setImmediate(() => {
                        handleConnectionIssue(true, errorType).catch(err => {
                            log.error("❌ Background reconnection trigger failed:", err);
                        });
                    });
                }
            },
            debug: log.debug.bind(log),
            raw: (level, msg, ...args) => {
                if (level === 'error') {
                    log.error(msg, ...args);
                } else if (level === 'warn') {
                    log.warn(msg, ...args);
                } else if (level === 'debug') {
                    log.debug(msg, ...args);
                } else {
                    log.info(msg, ...args);
                }
            }
        },
        ...proxyOptions
    };
}

async function createTelegramClientInstance(config, dcConfig, clientConfig, sessionString) {
    return await telegramCircuitBreaker.execute(async () => {
        if (!config.apiId || !config.apiHash) {
            throw new Error("Your API ID or Hash cannot be empty or undefined");
        }

        const session = new StringSession(sessionString);

        if (dcConfig.mode === "test-default") {
            clientConfig.testServers = true;
            log.info(`📡 使用测试服务器模式 (testServers: true)`);
        } else if (dcConfig.mode === "custom") {
            clientConfig.testServers = true;
            log.info(`📡 尝试使用测试服务器模式 (testServers: true)，保留自定义 DC 设置: DC ${dcConfig.dcId} @ ${dcConfig.serverIp}:${dcConfig.serverPort}`);
        }

        const client = new TelegramClient(
            session,
            config.apiId,
            config.apiHash,
            clientConfig
        );

        if (dcConfig.mode !== "default") {
            client.session.setDC(dcConfig.dcId, dcConfig.serverIp, dcConfig.serverPort);
        }

        return client;
    }, TelegramErrorClassifier.ERROR_TYPES.UNKNOWN);
}

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
        const config = getConfig();
        const dcConfig = getTelegramDcConfig(config);
        logTelegramDcConfig(dcConfig);

        const proxyOptions = buildProxyOptions(config);
        const sessionString = await getSavedSession();
        const clientConfig = buildClientConfig(config, proxyOptions);

        enableTelegramConsoleProxy();

        telegramClient = await createTelegramClientInstance(config, dcConfig, clientConfig, sessionString);

        setupEventListeners(telegramClient);

        // 挂客户端级错误钩子:接管 gramjs 内部 _borrowExportedSender/_connectSender 的错误路径,
        // 用退避 await 打断无刹车的递归洪流(否则事件循环被饿死、进程瘫成活死人)。
        telegramClient.onError = handleTelegramClientError;


        return telegramClient;
    } finally {
        isClientInitializing = false;
    }
}

/**
 * 设置事件监听器（增强版）
 */
/**
 * 处理 Telegram 客户端错误
 */
function handleTelegramError(err) {
    const errorType = TelegramErrorClassifier.classify(err);
    lastErrorType = errorType;

    // 记录错误类型统计
    errorTypeFailures[errorType] = (errorTypeFailures[errorType] || 0) + 1;

    // 特殊处理 FLOOD
    if (errorType === TelegramErrorClassifier.ERROR_TYPES.FLOOD) {
         const waitSeconds = err.seconds || 60;
         log.error(`🚨 检测到 Telegram Flood Wait: 需要等待 ${waitSeconds} 秒。`, { service: 'telegram', waitSeconds });
    } else {
         log.error(`⚠️ Telegram 错误 [${errorType}]: ${err.message}`, { service: 'telegram' });
    }

    // 检查是否需要触发电路断路器
    if (TelegramErrorClassifier.shouldTripCircuitBreaker(errorType, errorTypeFailures[errorType])) {
        telegramCircuitBreaker.onFailure(errorType, err);
    }

    // 检查是否需要跳过重连
    if (TelegramErrorClassifier.shouldSkipReconnect(errorType)) {
        log.warn(`⚠️ 错误类型 ${errorType} 需要特殊处理，跳过普通重连`);
        return;
    }

    // 获取推荐的重连策略
    const strategy = TelegramErrorClassifier.getReconnectStrategy(errorType, errorTypeFailures[errorType], err);

    if (!strategy.shouldRetry) {
        log.warn(`⚠️ 错误类型 ${errorType} 已超过最大重试次数，停止重连尝试`);
        return;
    }

    // 执行重连
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        const shouldFullReset = TelegramErrorClassifier.shouldResetSession(errorType, errorTypeFailures[errorType]);
        handleConnectionIssue(!shouldFullReset, errorType);
    }, strategy.delay);
}

/**
 * 设置健康监控，检测更新循环是否卡死
 */
function setupHealthMonitor(client) {
    // 更新循环健康监控
    let consecutiveUpdateTimeouts = 0;
    client.addEventHandler((update) => {
        try {
            lastUpdateTimestamp = Date.now();
            if (consecutiveFailures > 0) {
                consecutiveFailures = 0;
            }
            if (consecutiveUpdateTimeouts > 0) {
                consecutiveUpdateTimeouts = 0;
            }
        } catch (error) {
            log.error('Error in event handler:', { error: error.message, stack: error.stack });
        }
    });

    client.on("connected", () => {
        if (updateHealthMonitor) clearInterval(updateHealthMonitor);

        updateHealthMonitor = setInterval(async () => {
            try {
                const timeSinceLastUpdate = Date.now() - lastUpdateTimestamp;

                if (timeSinceLastUpdate > 60000 && timeSinceLastUpdate <= 120000) {
                    log.warn(`⚠️ 更新循环缓慢 (已持续 ${Math.floor(timeSinceLastUpdate / 1000)} 秒无更新)`);
                    consecutiveUpdateTimeouts++;

                    if (!isReconnecting) {
                        handleConnectionIssue(true, TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                    }
                } else if (timeSinceLastUpdate > 120000) {
                    log.error(`🚨 更新循环卡死 (${Math.floor(timeSinceLastUpdate / 1000)} 秒)，触发完整重置`, { service: 'telegram', duration: timeSinceLastUpdate });
                    telegramCircuitBreaker.onFailure(TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                    consecutiveUpdateTimeouts++;

                    if (consecutiveUpdateTimeouts > 2) {
                        await resetClientSession();
                        await handleConnectionIssue(false, TelegramErrorClassifier.ERROR_TYPES.TIMEOUT);
                        consecutiveUpdateTimeouts = 0;
                    }

                    lastUpdateTimestamp = Date.now();
                }
            } catch (error) {
                log.error('Error in health monitor interval:', { error: error.message, stack: error.stack });
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

function setupEventListeners(client) {
    client.on("connected", () => {
        log.info("🔗 Telegram 客户端连接已建立");
        lastUpdateTimestamp = Date.now(); // 重置更新时间戳，防止误报
        if (connectionStatusCallback) {
            connectionStatusCallback(true);
        }
    });

    client.on("disconnected", () => {
        log.info("🔌 Telegram 客户端连接已断开");
        if (connectionStatusCallback) {
            connectionStatusCallback(false);
        }
    });

    // 增强错误处理：使用错误分类器
    client.on("error", handleTelegramError);

    // 设置健康监控
    setupHealthMonitor(client);
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

export const isClientActive = () => {
    return Boolean(telegramClient?.connected);
};

export const ensureConnected = async () => {
    const client = await getClient();
    if (client.connected) return;

    // 主动触发一次重连(非阻塞),不必干等看门狗周期;reconnectBot 内部按
    // isReconnecting/锁/熔断器去重,并发调用安全。
    reconnectBot(true).catch(() => {});

    log.info("⏳ 等待 Telegram 客户端连接...");
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Telegram client connection timeout after 30 seconds"));
        }, 30000);

        const checkConnected = () => {
            if (client.connected) {
                clearTimeout(timeout);
                log.info("✅ Telegram 客户端连接已确认");
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
        log.debug("🔄 Reconnection already in progress, skipping duplicate");
        return;
    }
    
    // 检查电路断路器状态
    if (telegramCircuitBreaker.state === 'OPEN') {
        log.warn("🚨 Circuit breaker is OPEN, blocking reconnection attempts");
        return;
    }
    
    // Telegram runtime ownership is governed only by the telegram_client lease.
    // Recovery paths may reconnect an owned client, but they must not acquire leadership.
    try {
        const hasLock = await hasTelegramClientLock({ logContention: false });
        if (!hasLock) {
            await stopLocalClientIfPresent('reconnect skipped because this instance does not own telegram_client lock');
            log.warn("🚨 当前实例未持有 telegram_client 锁，取消重连");
            return;
        }
    } catch (e) {
        log.warn(`⚠️ Lock check failed: ${e.message},暂缓重连`);
        return;
    }

    // 检查是否应该跳过重连
    if (TelegramErrorClassifier.shouldSkipReconnect(errorType)) {
        log.warn(`⚠️ Skipping reconnection for error type: ${errorType}`);
        return;
    }

    isReconnecting = true;
    reconnectStartedAt = Date.now();

    try {
        const client = await getClient();
        const config = getConfig();
        const strategy = TelegramErrorClassifier.getReconnectStrategy(errorType, errorTypeFailures[errorType] || 0);

        log.info(`🔄 开始重连 [类型=${errorType}, lightweight=${lightweight}, 延迟=${strategy.delay}ms]`);

        // 增强断开连接
        try {
            if (client.connected) {
                await Promise.race([
                    client.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 8000))
                ]);
                log.info("✅ 客户端已优雅断开连接");
            }
        } catch (de) {
            log.warn("⚠️ 断开连接超时或出错:", de.message);
        }

        // 清理发送器
        if (client._sender) {
            try {
                await Promise.race([
                    client._sender.disconnect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Sender disconnect timeout")), 5000))
                ]);
                client._sender = undefined;
                log.info("✅ Sender 状态已清理");
            } catch (e) {
                log.warn("⚠️ Sender 清理失败:", e.message);
                client._sender = undefined;
            }
        }

        // Session 管理
        const shouldReset = TelegramErrorClassifier.shouldResetSession(errorType, errorTypeFailures[errorType] || 0);
        if (!lightweight || shouldReset) {
            log.info("🔄 因错误类型或策略重置 Session");
            await resetClientSession();
        } else {
            log.info("🔄 轻量重连 - 保留 Session");
        }

        // 等待策略延迟
        log.info(`⏳ 重连退避: ${Math.floor(strategy.delay / 1000)} 秒`);
        await new Promise(r => setTimeout(r, strategy.delay));

        // 使用电路断路器保护重连
        await telegramCircuitBreaker.execute(async () => {
            // 每一步都套超时:任一步挂起都必须抛错,否则下面的 finally 无法复位 isReconnecting,
            // 会导致看门狗与后续所有重连被永久锁死(线上曾因此 6.5 小时无法自愈)。
            await withTimeout(client.connect(), RECONNECT_STEP_TIMEOUT_MS, 'client.connect');
            await withTimeout(client.start({ botAuthToken: config.botToken }), RECONNECT_STEP_TIMEOUT_MS, 'client.start');
            await withTimeout(saveSession(), RECONNECT_STEP_TIMEOUT_MS, 'saveSession');

            log.info("✅ 重连成功");
            lastHeartbeat = Date.now();
            consecutiveFailures = 0;

            // 验证连接健康
            const healthCheck = await withTimeout(client.getMe(), RECONNECT_HEALTHCHECK_TIMEOUT_MS, 'client.getMe').catch(e => {
                log.error("❌ 重连后健康检查失败:", e);
                throw e;
            });

            if (healthCheck) {
                log.info("✅ 连接健康状态已验证");
                // 重置错误统计
                errorTypeFailures[errorType] = 0;
            }
        }, errorType);

    } catch (e) {
        log.error("❌ 重连失败:", e);
        consecutiveFailures++;

        // 如果连续失败次数过多，触发电路断路器
        if (consecutiveFailures >= 3) {
            log.error("🚨 多次重连失败，开启电路断路器");
            telegramCircuitBreaker.onFailure(errorType);
        }
    } finally {
        isReconnecting = false;
        reconnectStartedAt = 0;
    }
}


/**
 * 处理 AUTH_KEY_DUPLICATED 错误
 */
const handleAuthKeyDuplicated = async () => {
    log.error("🚨 检测到 AUTH_KEY_DUPLICATED，会话已在别处激活");
    lastHeartbeat = 0;

    try {
        // 1. 强制清理 telegramClient，避免使用 getClient() 导致重新初始化或副作用
        // 修复: 避免调用 resetClientSession() 再次触发 disconnect 导致 crash
        if (telegramClient) {
            try {
                // 尝试断开底层连接，忽略错误
                if (telegramClient._sender) {
                    await telegramClient._sender.disconnect().catch(() => {});
                }
                await telegramClient.disconnect().catch(() => {});
            } catch (err) {
                // ignore
            }
            telegramClient = null;
        }

        // 2. 清除会话持久化
        try {
            await SettingsRepository.set("tg_bot_session", "");
            log.info("🗑️ 已清除全局 Session (AUTH_KEY_DUPLICATED)");
        } catch (err) {
            log.error("❌ 清除 Session 失败:", err);
        }

        // 3. 重置状态
        isClientInitializing = false;
        isReconnecting = false;
        telegramDcConfig = null;
        telegramDcConfigLogged = false;
    } finally {
        // 4. 确保锁一定会被释放，即使上面任何步骤抛出异常
        try {
            await instanceCoordinator.releaseLock(TELEGRAM_CLIENT_LOCK);
        } catch (lockErr) {
            log.error("❌ 释放锁失败:", lockErr);
        }
    }

    log.info("♻️ 系统状态已重置，等待看门狗下一次周期尝试重新登录");
};

/**
 * 处理看门狗失败阈值达到重连的逻辑
 */
const handleWatchdogFailureThreshold = async (errorType, diff) => {
    log.error(`🚨 Heartbeat threshold exceeded, triggering reconnection... (diff=${diff}, failures=${consecutiveFailures})`);

    try {
        const hasLock = await hasTelegramClientLock({ logContention: false });
        if (!hasLock) {
            await stopLocalClientIfPresent('watchdog recovery skipped because this instance does not own telegram_client lock');
            resetWatchdogFailureState();
            return;
        }
    } catch (lockCheckError) {
        log.warn(`⚠️ 看门狗锁检查失败: ${lockCheckError.message}`);
    }

    handleConnectionIssue(true, errorType);
};

/**
 * 启动看门狗定时器（增强版）
 */
export const startWatchdog = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    const watchdogId = Math.random().toString(36).substring(7);
    log.info(`🐶 Starting watchdog [ID: ${watchdogId}] for instance [${instanceCoordinator.getInstanceId()}]`);
    
    watchdogTimer = setInterval(async () => {
        const now = Date.now();

        // 处理时间回拨
        if (lastHeartbeat > now) {
            log.info(`🕒 检测到时间回拨，重置心跳时间: last=${lastHeartbeat}, now=${now}`);
            lastHeartbeat = now;
            isReconnecting = false;
            consecutiveFailures = 0;
        }

        if (isReconnecting) {
            // 兜底:重连正常应在 RECONNECT_STEP_TIMEOUT_MS 内结束;若 isReconnecting 长时间未复位,
            // 说明某处 await 卡死(如未被 withTimeout 包裹的路径),强制解锁让自愈得以继续。
            if (isReconnectStuck(now, reconnectStartedAt, MAX_RECONNECT_STUCK_MS)) {
                log.error(`🚨 重连疑似卡死超过 ${Math.floor(MAX_RECONNECT_STUCK_MS / 1000)}s,强制解除锁定以恢复自愈`, {
                    service: 'telegram',
                    stuckMs: now - reconnectStartedAt
                });
                isReconnecting = false;
                reconnectStartedAt = 0;
                // 不 return:让本轮继续检测连接状态并按需触发新的重连
            } else {
                return;
            }
        }

        try {
            const ownsTelegramClient = await hasTelegramClientLock({ logContention: false });
            if (!ownsTelegramClient) {
                await stopLocalClientIfPresent('watchdog skipped because this instance does not own telegram_client lock');
                resetWatchdogFailureState();
                log.debug("🔒 Watchdog standby tick skipped: telegram_client lock is owned elsewhere");
                return;
            }

            // 检查电路断路器状态。只有锁持有者才需要报告 Telegram runtime 健康。
            const cbState = telegramCircuitBreaker.getState();
            if (cbState.state === 'OPEN') {
                const waitTime = Math.ceil((cbState.timeout - (now - cbState.lastFailure)) / 1000);
                log.warn(`⏸️ Watchdog paused - circuit breaker OPEN (${waitTime}s remaining)`);
                return;
            }

            const client = await getClient();
            if (!client.connected) {
                consecutiveFailures++;
                log.warn(`💔 Client disconnected, failure count: ${consecutiveFailures}`);
                
                if (now - lastHeartbeat >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                    log.error(`🚨 Reconnection threshold reached, triggering recovery (failures=${consecutiveFailures})`);
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
                await handleAuthKeyDuplicated();
                return;
            }

            const errorType = TelegramErrorClassifier.classify(e);
            log.warn(`💔 Heartbeat failed (${consecutiveFailures}/3) [ID: ${watchdogId}]: [${errorType}] ${e.message || e}`);

            const currentNow = Date.now();
            const diff = currentNow - lastHeartbeat;

            if (diff >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                await handleWatchdogFailureThreshold(errorType, diff);
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
    reconnectStartedAt = 0;
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
    log.info("🔄 Circuit breaker manually reset");
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
            const config = getConfig();
            log.info("🔌 正在连接 Telegram 客户端...");
            
            // 使用电路断路器保护连接过程，捕获 FloodWaitError
            await telegramCircuitBreaker.execute(async () => {
                await client.connect();
            }, TelegramErrorClassifier.ERROR_TYPES.UNKNOWN);
            
            log.info("🤖 正在启动 Telegram Bot...");
            
            // 使用电路断路器保护启动过程，捕获 FloodWaitError
            await telegramCircuitBreaker.execute(async () => {
                await client.start({ botAuthToken: config.botToken });
            }, TelegramErrorClassifier.ERROR_TYPES.UNKNOWN);
            
            await saveSession();
            
            enableTelegramConsoleProxy();
            log.info("✅ Telegram 控制台代理已启用");
            
            // 输出当前 DC 信息（在连接后）
            await logCurrentDCInfo(client, getConfig());
        }
        
        return client;
    } catch (error) {
        // 重新分类错误以进行适当处理
        const errorType = TelegramErrorClassifier.classify(error);
        
        if (errorType === TelegramErrorClassifier.ERROR_TYPES.FLOOD) {
            const waitSeconds = error.seconds || 60;
            log.error(`🚨 Telegram Flood Wait Detected during connect/start: A wait of ${waitSeconds} seconds is required.`, { service: 'telegram', waitSeconds });
            
            // 触发电路断路器
            telegramCircuitBreaker.onFailure(errorType, error);
            
            // 抛出错误以便上层处理
            throw error;
        } else {
            log.error("❌ Telegram 客户端连接启动失败:", error);
            throw error;
        }
    }
};

/**
 * 重新连接 Telegram Bot (供外部调用)
 * @param {boolean} lightweight - 是否轻量重连
 */
export const reconnectBot = async (lightweight = true) => {
    await handleConnectionIssue(lightweight, TelegramErrorClassifier.ERROR_TYPES.UNKNOWN);
};

/**
 * 设置连接状态回调函数
 * @param {Function} callback - 回调函数，接收一个布尔值参数表示连接状态
 */
export const setConnectionStatusCallback = (callback) => {
    connectionStatusCallback = typeof callback === 'function' ? callback : null;
};

// 导出启动函数（不在模块加载时自动启动，由应用显式调用）
export const startTelegramWatchdog = () => {
    if (process.env.NODE_ENV !== 'test') {
        startWatchdog();
    }
};
