import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import logger from "./logger.js";

// Circuit Breaker State
const circuitBreaker = {
    failures: 0,
    lastFailure: null,
    state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
    threshold: 5,
    timeout: 60000, // 1 minute before attempting half-open
    resetTimer: null
};

/**
 * Circuit Breaker Implementation
 */
class TelegramCircuitBreaker {
    constructor() {
        this.state = 'CLOSED';
        this.failures = 0;
        this.lastFailure = null;
        this.threshold = 5;
        this.timeout = 60000;
        this.resetTimer = null;
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            const timeSinceFailure = Date.now() - this.lastFailure;
            if (timeSinceFailure < this.timeout) {
                throw new Error(`Circuit breaker is OPEN. Wait ${Math.ceil((this.timeout - timeSinceFailure) / 1000)}s more`);
            }
            // Transition to HALF_OPEN
            this.state = 'HALF_OPEN';
            logger.info('🔄 Circuit breaker transitioning to HALF_OPEN state');
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
            logger.info('✅ Circuit breaker closed - connection restored');
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
            
            // Schedule automatic reset attempt
            if (this.resetTimer) clearTimeout(this.resetTimer);
            this.resetTimer = setTimeout(() => {
                if (this.state === 'OPEN') {
                    this.state = 'HALF_OPEN';
                    logger.info('🔄 Circuit breaker attempting HALF_OPEN recovery');
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
 * Enhanced Telegram Client with improved timeout handling
 */
let telegramClient = null;
let isClientInitializing = false;
let connectionStatusCallback = null;
let reconnectTimeout = null;
let isReconnecting = false;
let lastHeartbeat = Date.now();
let consecutiveFailures = 0;
let watchdogTimer = null;

// Enhanced configuration with better timeout management
const CLIENT_CONFIG = {
    connectionRetries: 15, // Reduced from 30 to prevent extended retry storms
    floodSleepThreshold: 60,
    deviceModel: "DriveCollector-Server",
    systemVersion: "Linux",
    appVersion: "2.3.3",
    useWSS: false,
    autoReconnect: true,
    timeout: 30000, // Reduced from 60s to 30s for faster failure detection
    requestRetries: 10, // Reduced from 15
    retryDelay: 2000, // Reduced from 3s to 2s
    dcId: undefined,
    useIPv6: false,
    maxConcurrentDownloads: 3,
    connectionPoolSize: 5,
    // NEW: Additional stability settings
    connectionTimeout: 15000, // Connection establishment timeout
    socketTimeout: 20000, // Socket read/write timeout
    keepAliveTimeout: 30000, // Keep-alive ping interval
};

/**
 * Initialize Telegram Client with enhanced error handling
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
        // Proxy configuration
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
        
        // Use circuit breaker for client creation
        telegramClient = await telegramCircuitBreaker.execute(async () => {
            return new TelegramClient(
                new StringSession(sessionString),
                config.apiId,
                config.apiHash,
                {
                    ...CLIENT_CONFIG,
                    ...proxyOptions,
                    // Enhanced base logger with timeout awareness
                    baseLogger: {
                        info: logger.info.bind(logger),
                        warn: logger.warn.bind(logger),
                        error: (msg, ...args) => {
                            // Enhanced error logging for timeout patterns
                            if (msg.includes('TIMEOUT') || msg.includes('timeout')) {
                                logger.warn(`⚠️ Telegram timeout detected: ${msg}`, ...args);
                                // Trigger circuit breaker
                                telegramCircuitBreaker.onFailure();
                            } else {
                                logger.error(msg, ...args);
                            }
                        },
                        debug: logger.debug.bind(logger),
                    }
                }
            );
        });
        
        // Enhanced event listeners
        setupEnhancedEventListeners(telegramClient);
        
        return telegramClient;
    } finally {
        isClientInitializing = false;
    }
}

/**
 * Enhanced event listeners with better timeout detection
 */
function setupEnhancedEventListeners(client) {
    // Connection state tracking
    let lastUpdateTimestamp = Date.now();
    let updateTimeoutCheck = null;

    // Monitor update loop health
    const startUpdateHealthMonitor = () => {
        if (updateTimeoutCheck) clearInterval(updateTimeoutCheck);
        
        updateTimeoutCheck = setInterval(() => {
            const timeSinceLastUpdate = Date.now() - lastUpdateTimestamp;
            
            // If no updates for 90 seconds, consider the update loop stuck
            if (timeSinceLastUpdate > 90000) {
                logger.warn(`⚠️ Update loop appears stuck (no updates for ${Math.floor(timeSinceLastUpdate / 1000)}s)`);
                
                // Trigger reconnection
                if (!isReconnecting) {
                    handleConnectionIssue(true);
                }
                
                // Reset timestamp to prevent repeated triggers
                lastUpdateTimestamp = Date.now();
            }
        }, 30000); // Check every 30 seconds
    };

    client.on("connected", () => {
        logger.info("🔗 Telegram 客户端连接已建立");
        lastUpdateTimestamp = Date.now();
        startUpdateHealthMonitor();
        
        if (connectionStatusCallback) {
            connectionStatusCallback(true);
        }
    });

    client.on("disconnected", () => {
        logger.info("🔌 Telegram 客户端连接已断开");
        if (updateTimeoutCheck) {
            clearInterval(updateTimeoutCheck);
            updateTimeoutCheck = null;
        }
        
        if (connectionStatusCallback) {
            connectionStatusCallback(false);
        }
    });

    // Enhanced error handling with timeout detection
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
            logger.warn(`⚠️ Telegram TIMEOUT error detected: ${errorMsg}`);
            telegramCircuitBreaker.onFailure();
            
            // Enhanced reconnection with exponential backoff
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            const backoffDelay = Math.min(1000 * Math.pow(2, circuitBreaker.failures), 30000);
            reconnectTimeout = setTimeout(() => handleConnectionIssue(true), backoffDelay);
            
        } else if (isConnectionError) {
            logger.warn(`⚠️ Telegram connection error: ${errorMsg}`);
            handleConnectionIssue(true);
            
        } else if (isBinaryReaderError) {
            logger.warn(`⚠️ Telegram BinaryReader error: ${errorMsg}`);
            telegramCircuitBreaker.onFailure();
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(() => handleConnectionIssue(true), 2000);
            
        } else {
            logger.error("❌ Telegram client error:", err);
        }
    });

    // NEW: Listen for raw updates to track update loop health
    client.addEventHandler((update) => {
        lastUpdateTimestamp = Date.now();
        // Reset consecutive failures on successful update processing
        if (consecutiveFailures > 0) {
            consecutiveFailures = 0;
        }
    });
}

/**
 * Enhanced connection issue handler with circuit breaker integration
 */
async function handleConnectionIssue(lightweight = false) {
    if (isReconnecting) {
        logger.debug("🔄 Reconnection already in progress, skipping duplicate");
        return;
    }
    
    // Check circuit breaker state
    if (circuitBreaker.state === 'OPEN') {
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
        const baseDelay = 5000 + (circuitBreaker.failures * 2000);
        const jitter = Math.random() * 2000;
        const backoffTime = Math.min(baseDelay + jitter, 30000);
        
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
 * Enhanced watchdog with circuit breaker awareness
 */
function startEnhancedWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    
    watchdogTimer = setInterval(async () => {
        const now = Date.now();
        
        // Handle time drift
        if (lastHeartbeat > now) {
            logger.info(`🕒 Time drift detected, resetting state`);
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
            logger.warn(`⏸️ Watchdog paused - circuit breaker OPEN (${Math.ceil((cbState.timeout - (now - cbState.lastFailure)) / 1000)}s remaining)`);
            return;
        }

        try {
            const client = await getClient();
            
            if (!client.connected) {
                consecutiveFailures++;
                logger.warn(`💔 Client disconnected, failure count: ${consecutiveFailures}`);
                
                if (now - lastHeartbeat >= 5 * 60 * 1000 || consecutiveFailures >= 3) {
                    logger.error(`🚨 Reconnection threshold reached, triggering recovery`);
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
            consecutiveFailures = 0;
            
        } catch (e) {
            consecutiveFailures++;
            
            // Special handling for AUTH_KEY_DUPLICATED
            if (e.code === 406 && e.errorMessage?.includes("AUTH_KEY_DUPLICATED")) {
                logger.error("🚨 AUTH_KEY_DUPLICATED detected");
                await handleAuthKeyDuplicated();
                return;
            }
            
            logger.warn(`💔 Health check failed (${consecutiveFailures}/3): ${e.message}`);
            
            if (consecutiveFailures >= 3 || now - lastHeartbeat >= 5 * 60 * 1000) {
                logger.error(`🚨 Health check threshold exceeded, triggering reconnection`);
                handleConnectionIssue(true);
            }
        }
    }, 60000); // Check every 60 seconds
}

/**
 * Export enhanced functions
 */
export {
    telegramCircuitBreaker,
    initTelegramClient,
    handleConnectionIssue,
    startEnhancedWatchdog,
    CLIENT_CONFIG
};

// Export existing functions for backward compatibility
export * from "./telegram.js";