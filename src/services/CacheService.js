import { config } from "../config/index.js";
import { localCache } from "../utils/LocalCache.js";
import logger from "./logger.js";

/**
 * --- Cache 存储服务层 ---
 * 支持 Northflank Redis (标准协议)、Cloudflare KV 和 Upstash Redis REST API
 * 具有自动故障转移功能，并集成 L1 内存缓存减少物理调用
 */
class CacheService {
    constructor() {
        // L1 内存缓存配置
        this.l1CacheTtl = 10 * 1000; // 默认 10 秒内存缓存

        // Redis 配置 (Northflank) - 添加防御性编程
        const redisConfig = config.redis || {};
        this.redisUrl = redisConfig.url;
        this.redisHost = redisConfig.host;
        this.redisPort = redisConfig.port || 6379;
        this.redisPassword = redisConfig.password;
        this.hasRedis = !!(this.redisUrl || (this.redisHost && this.redisPort));

        // Cloudflare KV 配置 - 支持新旧变量名
        this.accountId = process.env.CF_CACHE_ACCOUNT_ID || process.env.CF_KV_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
        this.namespaceId = process.env.CF_CACHE_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID;
        this.token = process.env.CF_CACHE_TOKEN || process.env.CF_KV_TOKEN || process.env.CF_D1_TOKEN || process.env.CF_KV_TOKEN;
        this.apiUrl = this.accountId && this.namespaceId 
            ? `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`
            : '';
        this.hasCloudflare = !!(this.apiUrl && this.token);

        // Upstash备用配置
        this.upstashUrl = process.env.UPSTASH_REDIS_REST_URL ? process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '') : '';
        this.upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
        this.hasUpstash = !!(this.upstashUrl && this.upstashToken);

        // 故障转移状态
        this.currentProvider = 'cloudflare'; // 'redis' | 'cloudflare' | 'upstash'
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.lastError = null;
        this.recoveryTimer = null;

        // 动态导入 ioredis (环境检测)
        this.redisClient = null;
        this.heartbeatTimer = null; // 心跳定时器
        this._initRedis();

        // 设置默认提供商优先级
        this._setDefaultProvider();

        // 设置便利属性
        this.useRedis = this.currentProvider === 'redis';
        this.useUpstash = this.currentProvider === 'upstash';
    }

    /**
     * 动态初始化 Redis 客户端
     * 在不支持 TCP 的环境中不会导致崩溃
     */
    async _initRedis() {
        if (!this.hasRedis) {
            logger.info('ℹ️ 未配置 Redis，跳过初始化');
            return;
        }

        try {
            // 检测是否在 Node.js 环境
            if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
                logger.warn('⚠️ 非 Node.js 环境，无法使用标准 Redis 客户端');
                return;
            }

            // 动态导入 ioredis
            const Redis = (await import('ioredis')).default;
            
            // 构造连接配置 - 优化TCP keepalive和连接参数，适配Northflank环境
            const redisConfig = {
                connectTimeout: 15000, // Northflank环境连接超时调整为15秒
                keepAlive: 30000, // TCP keep-alive，每30秒发送一次（Northflank优化）
                family: 4, // 强制使用IPv4
                lazyConnect: true, // 延迟连接，避免启动时的连接风暴
                enableReadyCheck: true, // Northflank环境特定配置
                retryStrategy: (times) => {
                    const delay = Math.min(times * 200, 10000); // 指数退避，最大10秒间隔（Northflank优化）
                    logger.warn(`⚠️ Redis 重试尝试 ${times}，延迟 ${delay}ms`);
                    return delay;
                },
                reconnectOnError: (err) => {
                    const msg = err.message.toLowerCase();
                    // Northflank环境特殊处理：对ECONNRESET和timeout错误更宽容
                    const shouldReconnect = msg.includes('econnreset') ||
                                           msg.includes('timeout') ||
                                           msg.includes('network') ||
                                           !msg.includes('auth');
                    if (shouldReconnect) {
                        logger.warn(`⚠️ Redis 重连错误: ${err.message}，将尝试重连`);
                    }
                    return shouldReconnect;
                }
            };

            // 优先使用 URL，否则使用 host/port/password
            if (this.redisUrl) {
                redisConfig.url = this.redisUrl;
            } else {
                redisConfig.host = this.redisHost;
                redisConfig.port = this.redisPort;
                if (this.redisPassword) {
                    redisConfig.password = this.redisPassword;
                }
            }

            // 记录Redis配置信息（用于诊断）
            logger.info('🔄 Redis 初始化配置', {
                hasUrl: !!this.redisUrl,
                hasHost: !!this.redisHost,
                port: this.redisPort,
                hasPassword: !!this.redisPassword,
                connectTimeout: redisConfig.connectTimeout,
                maxRetriesPerRequest: redisConfig.maxRetriesPerRequest,
                node_env: process.env.NODE_ENV,
                platform: process.platform
            });

            this.redisClient = new Redis(redisConfig);

            // 连接事件监听 (增强诊断)
            this.redisClient.on('connect', () => {
                this.connectTime = Date.now();
                logger.info(`✅ Redis CONNECT: ${this.redisHost || this.redisUrl}:${this.redisPort} at ${new Date(this.connectTime).toISOString()}`, {
                    host: this.redisHost,
                    port: this.redisPort,
                    url: this.redisUrl ? 'configured' : 'not configured',
                    hasPassword: !!this.redisPassword,
                    node_env: process.env.NODE_ENV,
                    platform: process.platform
                });
            });

            this.redisClient.on('ready', () => {
                const connectDuration = Date.now() - this.connectTime;
                logger.info(`✅ Redis READY: Connection established in ${connectDuration}ms`, {
                    totalConnections: this.redisClient.options?.maxRetriesPerRequest || 'unknown',
                    connectTimeout: this.redisClient.options?.connectTimeout || 'unknown'
                });
            });

            this.redisClient.on('reconnecting', (ms) => {
                logger.warn(`🔄 Redis RECONNECTING: Attempting reconnection in ${ms}ms`, {
                    lastError: this.lastError,
                    failureCount: this.failureCount,
                    currentProvider: this.currentProvider
                });
            });

            this.redisClient.on('error', (error) => {
                const now = Date.now();
                const uptime = this.connectTime ? Math.round((now - this.connectTime) / 1000) : 0;
                logger.error(`🚨 Redis ERROR: ${error.message}`, {
                    code: error.code,
                    errno: error.errno,
                    syscall: error.syscall,
                    hostname: error.hostname,
                    port: error.port,
                    address: error.address,
                    uptime: `${uptime}s`,
                    node_env: process.env.NODE_ENV,
                    platform: process.platform,
                    stack: error.stack?.split('\n')[0] // 只记录第一行堆栈
                });
                this.lastRedisError = error.message;
            });

            this.redisClient.on('close', () => {
                const now = Date.now();
                const duration = this.connectTime ? now - this.connectTime : 0;
                logger.warn(`⚠️ Redis CLOSE: Connection closed after ${Math.round(duration / 1000)}s`, {
                    durationMs: duration,
                    lastError: this.lastRedisError || 'none',
                    failureCount: this.failureCount,
                    currentProvider: this.currentProvider,
                    hasPassword: !!this.redisPassword,
                    node_env: process.env.NODE_ENV,
                    platform: process.platform
                });
                // 清理心跳定时器
                this._stopHeartbeat();
            });

            // 添加更多诊断事件
            this.redisClient.on('wait', () => {
                logger.debug('🔄 Redis WAIT: Command queued, waiting for connection');
            });

            this.redisClient.on('end', () => {
                logger.warn('⚠️ Redis END: Connection ended by client');
            });

            this.redisClient.on('select', (db) => {
                logger.debug(`🔄 Redis SELECT: Database ${db} selected`);
            });

            // 测试连接并测量延迟 - 添加超时控制避免卡死
            const pingStart = Date.now();
            try {
                const pingPromise = this.redisClient.ping();
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Redis ping timeout after 10 seconds')), 10000)
                );

                const pingResult = await Promise.race([pingPromise, timeoutPromise]);
                const pingDuration = Date.now() - pingStart;

                logger.info('🔄 Cache服务：使用 Northflank Redis', {
                    pingResult,
                    pingDurationMs: pingDuration,
                    pingThreshold: pingDuration > 1000 ? 'high' : pingDuration > 500 ? 'medium' : 'low',
                    connectionReady: this.redisClient.status === 'ready',
                    node_env: process.env.NODE_ENV,
                    platform: process.platform
                });

                // 启动应用层心跳机制 - 每2分钟执行一次PING
                this._startHeartbeat();
            } catch (pingError) {
                const pingDuration = Date.now() - pingStart;
                logger.warn('⚠️ Redis ping 测试失败，但继续初始化以支持延迟连接', {
                    error: pingError.message,
                    durationMs: pingDuration,
                    clientStatus: this.redisClient.status,
                    node_env: process.env.NODE_ENV,
                    platform: process.platform
                });

                // 即使 ping 失败，也启动心跳机制（延迟连接时有用）
                this._startHeartbeat();
            }

        } catch (error) {
            logger.error(`🚨 Redis 初始化失败: ${error.message}`);
            this.redisClient = null;
        }
    }

    /**
     * 设置默认提供商优先级
     * 优先级：redis > cloudflare > upstash
     */
    _setDefaultProvider() {
        // 支持 CACHE_PROVIDER 和 KV_PROVIDER（兼容）
        const provider = process.env.CACHE_PROVIDER || process.env.KV_PROVIDER;
        if (provider) {
            // 强制指定提供商
            if (provider === 'redis' && this.hasRedis) {
                this.currentProvider = 'redis';
                logger.info('🔄 Cache服务：强制使用 Northflank Redis');
            } else if (provider === 'cloudflare' && this.hasCloudflare) {
                this.currentProvider = 'cloudflare';
                logger.info('🔄 Cache服务：强制使用 Cloudflare KV');
            } else if (provider === 'upstash' && this.hasUpstash) {
                this.currentProvider = 'upstash';
                logger.info('🔄 Cache服务：强制使用 Upstash Redis');
            } else {
                throw new Error(`强制使用 ${provider}，但该提供商未配置完整`);
            }
        } else {
            // 自动选择优先级
            if (this.hasRedis) {
                this.currentProvider = 'redis';
                logger.info('🔄 Cache服务：使用 Northflank Redis');
            } else if (this.hasCloudflare) {
                this.currentProvider = 'cloudflare';
                logger.info('🔄 Cache服务：使用 Cloudflare KV');
            } else if (this.hasUpstash) {
                this.currentProvider = 'upstash';
                logger.info('🔄 Cache服务：使用 Upstash Redis');
            } else {
                // 在测试环境中，如果没有配置任何提供商，使用 cloudflare 作为默认值
                this.currentProvider = 'cloudflare';
                logger.info('🔄 Cache服务：未配置任何提供商，使用 Cloudflare KV (默认)');
            }
        }

        // 启用故障转移
        this.failoverEnabled = this._calculateFailoverTargets().length > 0;
    }

    /**
     * 计算可用的故障转移目标
     */
    _calculateFailoverTargets() {
        const targets = [];
        if (this.currentProvider === 'redis' && this.hasCloudflare) {
            targets.push('cloudflare');
        }
        if (this.currentProvider === 'redis' && this.hasUpstash) {
            targets.push('upstash');
        }
        if (this.currentProvider === 'cloudflare' && this.hasUpstash) {
            targets.push('upstash');
        }
        return targets;
    }

    /**
     * 检查是否应该触发故障转移
     */
    _shouldFailover(error) {
        if (!this.failoverEnabled) {
            return false;
        }

        // 检查是否是额度限制错误或网络错误
        const isQuotaError = this._isRetryableError(error);

        if (isQuotaError) {
            this.failureCount++;
            this.lastFailureTime = Date.now();
            this.lastError = error.message || "Unknown error";

            // 连续3次额度/网络错误，触发故障转移
            if (this.failureCount >= 3) {
                const targets = this._calculateFailoverTargets();
                if (targets.length > 0) {
                    logger.warn(`⚠️ ${this.getCurrentProvider()} 连续失败 ${this.failureCount} 次，触发自动故障转移到 ${targets[0]}`);
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 执行故障转移
     */
    _failover() {
        const targets = this._calculateFailoverTargets();
        if (targets.length === 0) {
            return false;
        }

        const nextProvider = targets[0];

        // 关键修复：在启动新检查任务前，必须先清理可能存在的旧定时器
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }

        this.currentProvider = nextProvider;
        this.failureCount = 0; // 重置失败计数

        // 设置故障转移时间戳，用于定期尝试恢复
        this.failoverTime = Date.now();

        // 启动定期恢复检查
        this._startRecoveryCheck();

        logger.info(`✅ 已切换到 ${this._getProviderDisplayName(nextProvider)}`);
        return true;
    }

    /**
     * 获取提供商显示名称
     */
    _getProviderDisplayName(provider) {
        switch (provider) {
            case 'redis': return 'Northflank Redis';
            case 'cloudflare': return 'Cloudflare KV';
            case 'upstash': return 'Upstash Redis';
            default: return provider;
        }
    }

    /**
     * 启动恢复定时器（测试用公共方法）
     */
    startRecoveryTimer() {
        this._startRecoveryCheck();
    }

    /**
     * 停止恢复检查（清理定时器）
     */
    stopRecoveryCheck() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    }

    /**
     * 启动定期恢复检查
     */
    _startRecoveryCheck() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
        }

        // 根据错误类型动态调整检查间隔
        const isQuotaIssue = this.lastError && (
            this.lastError.includes('free usage limit') || 
            this.lastError.includes('quota exceeded')
        );
        
        const checkInterval = isQuotaIssue ? 12 * 60 * 60 * 1000 : 30 * 60 * 1000;
        logger.info(`🕒 启动 Cache 恢复检查，间隔: ${checkInterval / 60000} 分钟`);

        this.recoveryTimer = setInterval(async () => {
            // 根据当前提供商决定恢复目标
            if (this.currentProvider === 'upstash') {
                // 从 Upstash 恢复到 Cloudflare
                try {
                    await this._cloudflare_get('__health_check__');
                    logger.info('🔄 Cloudflare KV 已恢复，切换回主要提供商...');
                    this.currentProvider = 'cloudflare';
                    this.failureCount = 0;
                    this.lastError = null;

                    // 清理恢复检查定时器
                    if (this.recoveryTimer) {
                        clearInterval(this.recoveryTimer);
                        this.recoveryTimer = null;
                    }

                    logger.info('✅ 已恢复到 Cloudflare KV');
                } catch (error) {
                    // 恢复失败，继续使用当前提供商
                    logger.info('ℹ️ Cloudflare KV 仍不可用，继续使用 Upstash');
                }
            } else if (this.currentProvider === 'cloudflare' && this.hasRedis) {
                // 从 Cloudflare 恢复到 Redis（如果 Redis 可用）
                try {
                    if (this.redisClient) {
                        await this.redisClient.ping();
                        logger.info('🔄 Northflank Redis 已恢复，切换回主要提供商...');
                        this.currentProvider = 'redis';
                        this.failureCount = 0;
                        this.lastError = null;

                        // 清理恢复检查定时器
                        if (this.recoveryTimer) {
                            clearInterval(this.recoveryTimer);
                            this.recoveryTimer = null;
                        }

                        logger.info('✅ 已恢复到 Northflank Redis');
                    }
                } catch (error) {
                    // 恢复失败，继续使用当前提供商
                    logger.info('ℹ️ Northflank Redis 仍不可用，继续使用当前提供商');
                }
            }
        }, checkInterval);
    }

    /**
     * 获取当前使用的提供商名称
     */
    getCurrentProvider() {
        return this._getProviderDisplayName(this.currentProvider);
    }

    /**
     * 检查是否处于故障转移模式
     */
    get isFailoverMode() {
        const provider = process.env.CACHE_PROVIDER || process.env.KV_PROVIDER;
        if (provider) {
            return this.currentProvider !== provider;
        }
        return this.currentProvider !== 'redis' && this.hasRedis;
    }

    /**
     * 统一判断是否为可重试的网络/配额错误
     */
    _isRetryableError(error) {
        const msg = (error.message || "").toLowerCase();
        return msg.includes('free usage limit') ||
               msg.includes('quota exceeded') ||
               msg.includes('rate limit') ||
               msg.includes('fetch failed') ||
               msg.includes('network') ||
               msg.includes('timeout') ||
               msg.includes('network timeout') ||
               msg.includes('connection') ||
               msg.includes('econnreset');
    }

    /**
     * 执行操作并支持故障转移
     */
    async _executeWithFailover(operation, ...args) {
        // Fallback logic for Redis init failure in development
        if (this.currentProvider === 'redis' && !this.redisClient) {
            logger.warn('Redis client not initialized (likely local dev), fallback to Cloudflare KV');
            if (this.hasCloudflare) {
                this.currentProvider = 'cloudflare';
            } else if (this.hasUpstash) {
                this.currentProvider = 'upstash';
            } else {
                // In test environment, use local cache as last resort
                logger.warn('No fallback providers available, using local cache');
                return await this._local_cache_operation(operation, ...args);
            }
            logger.info(`🔄 Fallback to ${this.currentProvider}`);
            // Recurse once with new provider
            return await this._executeWithFailover(operation, ...args);
        }
    
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                if (this.currentProvider === 'redis') {
                    // Check if Redis client is available before attempting operation
                    if (!this.redisClient) {
                        throw new Error('Redis client not available');
                    }
                    return await this[`_redis_${operation}`](...args);
                } else if (this.currentProvider === 'upstash') {
                    return await this[`_upstash_${operation}`](...args);
                } else {
                    return await this[`_cloudflare_${operation}`](...args);
                }
            } catch (error) {
                attempts++;

                // For Redis errors, always try to failover if possible
                if (this.currentProvider === 'redis' && this.hasCloudflare && attempts < maxAttempts) {
                    logger.warn(`Redis operation failed: ${error.message}, attempting failover`);
                    this.currentProvider = 'cloudflare';
                    logger.info(`🔄 Failed over to ${this.getCurrentProvider()}`);
                    continue;
                }

                // For other providers, use retry logic
                if (!this._isRetryableError(error) || this.currentProvider === 'redis') {
                    throw error;
                }

                if (this._shouldFailover(error)) {
                    logger.info(`🔄 检测到可恢复错误，准备故障转移`, {
                        currentProvider: this.currentProvider,
                        failureCount: this.failureCount,
                        lastError: error.message,
                        errorType: this._isRetryableError(error) ? 'retryable' : 'non-retryable'
                    });
                    if (this._failover()) {
                        logger.info(`✅ 故障转移成功，现在使用 ${this.getCurrentProvider()}`);
                        continue;
                    } else {
                        logger.warn(`❌ 故障转移失败，无可用后备提供商`);
                    }
                }

                if (attempts >= maxAttempts) throw error;
                logger.info(`ℹ️ ${this.getCurrentProvider()} 重试中 (${attempts}/${maxAttempts})...`);
            }
        }
    }

    /**
     * 本地缓存操作（测试环境用）
     */
    async _local_cache_operation(operation, ...args) {
        const key = args[0];
        switch (operation) {
            case 'set':
                const value = args[1];
                const ttl = args[2];
                localCache.set(`cache:${key}`, value, (ttl || 10 * 60) * 1000);
                return true;
            case 'get':
                return localCache.get(`cache:${key}`);
            case 'delete':
                localCache.del(`cache:${key}`);
                return true;
            case 'listKeys':
                // Not implemented for local cache
                return [];
            case 'bulkSet':
                // Not implemented for local cache
                return args[0].map(() => ({ success: true, result: "OK" }));
            default:
                throw new Error(`Unknown operation: ${operation}`);
        }
    }

    /**
     * Redis get 实现
     */
    async _redis_get(key, type = "json") {
        if (!this.redisClient) {
            throw new Error('Redis 客户端未初始化');
        }

        const startTime = Date.now();
        try {
            const value = await this.redisClient.get(key);
            const duration = Date.now() - startTime;

            if (value === null || value === undefined) {
                logger.debug(`🔍 Redis GET: Key '${key}' not found`, {
                    durationMs: duration,
                    clientStatus: this.redisClient.status
                });
                return null;
            }

            let parsedValue;
            if (type === "json") {
                try {
                    parsedValue = JSON.parse(value);
                } catch (e) {
                    logger.warn(`⚠️ Redis GET: JSON parse failed for key '${key}', returning raw value`, {
                        error: e.message,
                        durationMs: duration
                    });
                    parsedValue = value;
                }
            } else {
                parsedValue = value;
            }

            logger.debug(`✅ Redis GET: Key '${key}' retrieved`, {
                durationMs: duration,
                valueSize: value.length,
                parsedType: type
            });

            return parsedValue;
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`🚨 Redis GET failed for key '${key}'`, {
                error: error.message,
                code: error.code,
                durationMs: duration,
                clientStatus: this.redisClient.status
            });
            throw error;
        }
    }

    /**
     * Redis set 实现
     */
    async _redis_set(key, value, expirationTtl = null) {
        if (!this.redisClient) {
            throw new Error('Redis 客户端未初始化');
        }

        const startTime = Date.now();
        try {
            const valueStr = typeof value === "string" ? value : JSON.stringify(value);
            let result;

            if (expirationTtl !== null && expirationTtl !== undefined) {
                const ttl = parseInt(expirationTtl, 10);
                if (!isNaN(ttl) && ttl > 0) {
                    result = await this.redisClient.set(key, valueStr, 'EX', ttl);
                    logger.debug(`✅ Redis SET with TTL: Key '${key}' set`, {
                        durationMs: Date.now() - startTime,
                        ttlSeconds: ttl,
                        valueSize: valueStr.length,
                        clientStatus: this.redisClient.status
                    });
                } else if (ttl !== 0) {
                    logger.warn(`⚠️ Redis SET: Invalid TTL value ${expirationTtl}, skipping expiration (${key})`, {
                        originalTtl: expirationTtl,
                        parsedTtl: ttl
                    });
                    result = await this.redisClient.set(key, valueStr);
                } else {
                    result = await this.redisClient.set(key, valueStr);
                }
            } else {
                result = await this.redisClient.set(key, valueStr);
            }

            const duration = Date.now() - startTime;
            logger.debug(`✅ Redis SET: Key '${key}' set successfully`, {
                durationMs: duration,
                valueSize: valueStr.length,
                hasTtl: expirationTtl !== null,
                result
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`🚨 Redis SET failed for key '${key}'`, {
                error: error.message,
                code: error.code,
                durationMs: duration,
                valueSize: typeof value === "string" ? value.length : JSON.stringify(value).length,
                clientStatus: this.redisClient.status
            });
            throw error;
        }
    }

    /**
     * Redis delete 实现
     */
    async _redis_delete(key) {
        if (!this.redisClient) {
            throw new Error('Redis 客户端未初始化');
        }

        const result = await this.redisClient.del(key);
        return result > 0;
    }

    /**
     * Redis listKeys 实现
     */
    async _redis_listKeys(prefix = '') {
        if (!this.redisClient) {
            throw new Error('Redis 客户端未初始化');
        }

        const keys = await this.redisClient.keys(`${prefix}*`);
        return keys;
    }

    /**
     * Redis bulkSet 实现
     */
    async _redis_bulkSet(pairs) {
        if (!this.redisClient) {
            throw new Error('Redis 客户端未初始化');
        }

        if (!Array.isArray(pairs)) {
            throw new Error("Redis bulkSet: pairs must be an array");
        }

        const pipeline = this.redisClient.pipeline();
        
        pairs.forEach(p => {
            if (!p || typeof p.key !== 'string' || p.value === undefined) {
                throw new Error("Redis bulkSet: each pair must have 'key' (string) and 'value'");
            }
            const valueStr = typeof p.value === "string" ? p.value : JSON.stringify(p.value);
            pipeline.set(p.key, valueStr);
        });

        const results = await pipeline.exec();
        return results.map(([error, result]) => ({
            success: !error,
            result: error ? error : result
        }));
    }

    /**
     * Cloudflare KV set 实现
     */
    async _cloudflare_set(key, value, expirationTtl = null) {
        if (!this.apiUrl || this.apiUrl.trim() === '') {
            throw new Error('Cloudflare KV API URL not configured. Please check CF_CACHE_ACCOUNT_ID and CF_CACHE_NAMESPACE_ID.');
        }

        if (!this.token) {
            throw new Error('Cloudflare KV token not configured. Please check CF_CACHE_TOKEN.');
        }

        const url = new URL(`${this.apiUrl}/values/${key}`);
        if (expirationTtl) {
            // Cloudflare KV requires minimum TTL of 60 seconds
            const minTtlSeconds = Math.max(expirationTtl, 60);
            url.searchParams.set("expiration_ttl", minTtlSeconds);
        }

        const response = await fetch(url.toString(), {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: typeof value === "string" ? value : JSON.stringify(value),
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Cache Set Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash set 实现
     */
    async _upstash_set(key, value, expirationTtl = null) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);

        const command = ["SET", key, valueStr];

        if (expirationTtl !== null && expirationTtl !== undefined) {
            const ttl = parseInt(expirationTtl, 10);
            if (!isNaN(ttl) && ttl > 0) {
                command.push("EX", ttl.toString());
            } else if (ttl !== 0) {
                logger.warn(`⚠️ Upstash set: 无效的 TTL 值 ${expirationTtl}，跳过过期设置 (${key})`);
            }
        }

        const response = await fetch(`${this.upstashUrl}/`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(command),
        });

        const result = await response.json();
        if (result.error) {
            logger.error(`🚨 Upstash Set Error for key '${key}':`, result.error);
            throw new Error(`Upstash Set Error: ${result.error}`);
        }
        return result.result === "OK";
    }

    /**
     * Cloudflare KV get 实现
     */
    async _cloudflare_get(key, type = "json") {
        if (!this.apiUrl || this.apiUrl.trim() === '') {
            throw new Error('Cloudflare KV API URL not configured. Please check CF_CACHE_ACCOUNT_ID and CF_CACHE_NAMESPACE_ID.');
        }
        
        if (!this.token) {
            throw new Error('Cloudflare KV token not configured. Please check CF_CACHE_TOKEN.');
        }
        
        const response = await fetch(`${this.apiUrl}/values/${key}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.token}`,
            },
        });

        if (response.status === 404) return null;
        if (!response.ok) {
            const result = await response.json();
            throw new Error(`Cache Get Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }

        if (type === "json") {
            return await response.json();
        }
        return await response.text();
    }

    /**
     * Upstash get 实现
     */
    async _upstash_get(key, type = "json") {
        const response = await fetch(`${this.upstashUrl}/get/${encodeURIComponent(key)}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
            },
        });

        const result = await response.json();
        if (result.error) {
            throw new Error(`Upstash Get Error: ${result.error}`);
        }

        const value = result.result;
        if (value === null || value === undefined) return null;

        if (type === "json") {
            try {
                return JSON.parse(value);
            } catch (e) {
                return value;
            }
        }
        return value;
    }

    /**
     * Cloudflare KV delete 实现
     */
    async _cloudflare_delete(key) {
        if (!this.apiUrl || this.apiUrl.trim() === '') {
            throw new Error('Cloudflare KV API URL not configured. Please check CF_CACHE_ACCOUNT_ID and CF_CACHE_NAMESPACE_ID.');
        }
        
        if (!this.token) {
            throw new Error('Cloudflare KV token not configured. Please check CF_CACHE_TOKEN.');
        }
        
        const response = await fetch(`${this.apiUrl}/values/${key}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${this.token}`,
            },
        });

        const result = await response.json();
        if (!result.success && response.status !== 404) {
            throw new Error(`Cache Delete Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash delete 实现
     */
    async _upstash_delete(key) {
        const response = await fetch(`${this.upstashUrl}/del/${encodeURIComponent(key)}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
            },
        });

        const result = await response.json();
        if (result.error) {
            throw new Error(`Upstash Delete Error: ${result.error}`);
        }
        return result.result > 0;
    }

    /**
     * Cloudflare KV bulkSet 实现
     */
    async _cloudflare_bulkSet(pairs) {
        if (!this.apiUrl || this.apiUrl.trim() === '') {
            throw new Error('Cloudflare KV API URL not configured. Please check CF_CACHE_ACCOUNT_ID and CF_CACHE_NAMESPACE_ID.');
        }
        
        if (!this.token) {
            throw new Error('Cloudflare KV token not configured. Please check CF_CACHE_TOKEN.');
        }
        
        const response = await fetch(`${this.apiUrl}/bulk`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(pairs.map(p => ({
                key: p.key,
                value: typeof p.value === "string" ? p.value : JSON.stringify(p.value)
            }))),
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Cache Bulk Set Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }
        // Cloudflare bulk API doesn't return per-item results, assume all successful
        return pairs.map(() => ({ success: true, result: "OK" }));
    }

    /**
     * Upstash bulkSet 实现
     */
    async _upstash_bulkSet(pairs) {
        if (!Array.isArray(pairs)) {
            throw new Error("Upstash bulkSet: pairs must be an array");
        }

        const commands = pairs.map(p => {
            if (!p || typeof p.key !== 'string' || p.value === undefined) {
                throw new Error("Upstash bulkSet: each pair must have 'key' (string) and 'value'");
            }
            const valueStr = typeof p.value === "string" ? p.value : JSON.stringify(p.value);
            return ["SET", p.key, valueStr];
        });

        const response = await fetch(`${this.upstashUrl}/pipeline`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(commands),
        });

        const results = await response.json();
        if (results.error) {
            throw new Error(`Upstash Pipeline Error: ${results.error}`);
        }
        const items = results.results || (Array.isArray(results) ? results : [results]);
        return items.map(r => ({
            success: !r.error,
            result: r.error ? r.error : r.result
        }));
    }

    /**
     * Cloudflare KV listKeys 实现
     */
    async _cloudflare_listKeys(prefix = '') {
        if (!this.apiUrl || this.apiUrl.trim() === '') {
            throw new Error('Cloudflare KV API URL not configured. Please check CF_CACHE_ACCOUNT_ID and CF_CACHE_NAMESPACE_ID.');
        }
        
        if (!this.token) {
            throw new Error('Cloudflare KV token not configured. Please check CF_CACHE_TOKEN.');
        }
        
        const url = new URL(`${this.apiUrl}/keys`);
        if (prefix) {
            url.searchParams.set('prefix', prefix);
        }

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.token}`,
            },
        });

        if (!response.ok) {
            const result = await response.json();
            throw new Error(`Cache ListKeys Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Cache ListKeys Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }

        // 返回键名数组
        return result.result.map(item => item.name);
    }

    /**
     * Upstash listKeys 实现
     */
    async _upstash_listKeys(prefix = '') {
        // 使用 KEYS 命令获取匹配的键
        const command = ["KEYS", `${prefix}*`];

        const response = await fetch(`${this.upstashUrl}/`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(command),
        });

        const result = await response.json();
        if (result.error) {
            logger.error(`🚨 Upstash ListKeys Error:`, result.error);
            throw new Error(`Upstash ListKeys Error: ${result.error}`);
        }

        return result.result || [];
    }

    /**
     * 写入键值对
     * @param {string} key
     * @param {any} value - 会被 JSON.stringify
     * @param {number} expirationTtl - 过期时间（秒），最小 60 秒
     * @param {Object} options - { skipCache: boolean }
     */
    async set(key, value, expirationTtl = null, options = {}) {
        // 1. 检查 L1 缓存，如果值没变且未过期，跳过物理写入（减少 Cache 调用）
        if (!options.skipCache && localCache.isUnchanged(`cache:${key}`, value)) {
            return true;
        }

        const result = await this._executeWithFailover('set', key, value, expirationTtl);
        
        // 2. 更新 L1 缓存
        if (result && !options.skipCache) {
            localCache.set(`cache:${key}`, value, this.l1CacheTtl);
        }
        
        return result;
    }

    /**
     * 读取键值
     * @param {string} key
     * @param {string} type - 'text' | 'json'
     * @param {Object} options - { skipCache: boolean, cacheTtl: number }
     */
    async get(key, type = "json", options = {}) {
        // 1. 尝试从 L1 缓存获取
        if (!options.skipCache) {
            const cached = localCache.get(`cache:${key}`);
            if (cached !== null) return cached;
        }

        const value = await this._executeWithFailover('get', key, type);
        
        // 2. 写入 L1 缓存
        if (value !== null && !options.skipCache) {
            localCache.set(`cache:${key}`, value, options.cacheTtl || this.l1CacheTtl);
        }
        
        return value;
    }

    /**
     * 删除键
     * @param {string} key
     */
    async delete(key) {
        localCache.del(`cache:${key}`);
        return await this._executeWithFailover('delete', key);
    }

    /**
     * 列出指定前缀的键
     * @param {string} prefix - 键前缀
     * @returns {Array<string>} 键名数组
     */
    async listKeys(prefix = '') {
        return await this._executeWithFailover('listKeys', prefix);
    }

    /**
     * 批量写入
     * @param {Array<{key: string, value: string}>} pairs
     */
    async bulkSet(pairs) {
        pairs.forEach(p => {
            localCache.set(`cache:${p.key}`, p.value, this.l1CacheTtl);
        });
        return await this._executeWithFailover('bulkSet', pairs);
    }

    /**
     * 启动应用层心跳机制 - Northflank环境优化，每30秒执行一次PING
     */
    _startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        const heartbeatInterval = 30 * 1000; // Northflank环境：30秒间隔（从2分钟减少）
        logger.info(`🫀 启动 Redis 心跳机制，间隔: ${heartbeatInterval / 1000} 秒 (Northflank优化)`);

        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 3;

        this.heartbeatTimer = setInterval(async () => {
            if (!this.redisClient || this.redisClient.status !== 'ready') {
                logger.debug('💔 心跳跳过：Redis 客户端未就绪');
                return;
            }

            try {
                const pingStart = Date.now();
                const pingResult = await this.redisClient.ping();
                const pingDuration = Date.now() - pingStart;

                // Northflank环境：更详细的延迟监控
                const isHighLatency = pingDuration > 200; // 200ms作为高延迟阈值

                logger.debug('💓 Redis 心跳 PING', {
                    result: pingResult,
                    durationMs: pingDuration,
                    status: this.redisClient.status,
                    latencyLevel: isHighLatency ? 'high' : 'normal',
                    node_env: process.env.NODE_ENV
                });

                // 重置连续失败计数
                consecutiveFailures = 0;

                // 如果PING延迟过高，在Northflank环境记录警告
                if (isHighLatency) {
                    logger.warn('⚠️ Redis 高延迟心跳', {
                        durationMs: pingDuration,
                        threshold: '200ms',
                        environment: 'northflank'
                    });
                }

                // 如果PING失败，记录错误但不强制重连（依赖ioredis内置重连）
                if (pingResult !== 'PONG') {
                    logger.warn('⚠️ Redis 心跳异常响应', { result: pingResult });
                }
            } catch (error) {
                consecutiveFailures++;
                logger.warn('🚨 Redis 心跳失败', {
                    error: error.message,
                    code: error.code,
                    clientStatus: this.redisClient?.status,
                    consecutiveFailures,
                    maxAllowed: maxConsecutiveFailures
                });

                // Northflank环境：如果连续失败超过阈值，记录更详细的诊断信息
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    logger.error('🚨 Redis 心跳连续失败超过阈值', {
                        consecutiveFailures,
                        lastError: error.message,
                        environment: 'northflank',
                        recommendation: '检查网络连接和Redis服务状态'
                    });
                    // 不主动断开连接，让ioredis处理重连
                }
            }
        }, heartbeatInterval);
    }

    /**
     * 停止心跳机制
     */
    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            logger.info('🛑 Redis 心跳机制已停止');
        }
    }
}

export const cache = new CacheService();