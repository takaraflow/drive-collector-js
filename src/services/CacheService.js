import { config } from "../config/index.js";
import { localCache } from "../utils/LocalCache.js";
import { upstashRateLimiter } from "../utils/RateLimiter.js";
import { logger } from "./logger.js";

/**
 * --- Cache 存储服务层 ---
 * 支持 Northflank Redis (标准协议)、Cloudflare KV 和 Upstash Redis REST API
 * 具有自动故障转移功能，并集成 L1 内存缓存减少物理调用
 */
export class CacheService {
    constructor() {
        // L1 内存缓存配置
        this.l1CacheTtl = 10 * 1000; // 默认 10 秒内存缓存

        // 为了在 constructor 中安全检查提供商配置，先提取配置变量
        const redisConfig = config.redis || {};
        const cf_accountId = process.env.CF_CACHE_ACCOUNT_ID || process.env.CF_KV_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
        const cf_namespaceId = process.env.CF_CACHE_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID;
        const cf_token = process.env.CF_CACHE_TOKEN || process.env.CF_KV_TOKEN; // 修复：移除 CF_D1_TOKEN（D1 token 非 KV token），避免误判 hasCloudflare
        const up_url = process.env.UPSTASH_REDIS_REST_URL ? process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '') : '';
        const up_token = process.env.UPSTASH_REDIS_REST_TOKEN;

        // 设置配置检测属性
        this.hasRedis = !!((redisConfig.url && redisConfig.url.trim() !== '') || (redisConfig.host && redisConfig.host.trim() !== '' && redisConfig.host !== '127.0.0.1' && redisConfig.host !== 'localhost'));
        this.hasCloudflare = !!(cf_accountId && cf_accountId.trim() !== '' && cf_namespaceId && cf_namespaceId.trim() !== '' && cf_token && cf_token.trim() !== '');
        this.hasUpstash = !!(up_url && up_url.trim() !== '' && up_token && up_token.trim() !== '');

        // 特殊处理测试环境：如果正在运行测试，且显式删除了环境变量，则强制为 false
        if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
            if (!process.env.NF_REDIS_URL && !process.env.NF_REDIS_HOST && !process.env.REDIS_URL && !process.env.REDIS_HOST) {
                this.hasRedis = false;
            }
            if (!process.env.CF_CACHE_ACCOUNT_ID && !process.env.CF_KV_ACCOUNT_ID && !process.env.CF_ACCOUNT_ID) {
                this.hasCloudflare = false;
            }
            if (!process.env.UPSTASH_REDIS_REST_URL) {
                this.hasUpstash = false;
            }
        }

        // Redis 配置赋值
        this.redisUrl = redisConfig.url;
        this.redisHost = redisConfig.host;
        this.redisPort = redisConfig.port || 6379;
        this.redisPassword = redisConfig.password;

        // Cloudflare KV 配置赋值
        this.accountId = cf_accountId;
        this.namespaceId = cf_namespaceId;
        this.token = cf_token;
        this.apiUrl = this.hasCloudflare
            ? `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`
            : '';

        // Upstash 备用配置赋值
        this.upstashUrl = up_url;
        this.upstashToken = up_token;

        // 故障转移状态
        this.currentProvider = 'cloudflare'; // 默认值
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.lastError = null;
        this.recoveryTimer = null;
        this.destroyed = false; // 销毁标志

        // 动态导入 ioredis (环境检测)
        this.redisClient = null;
        this.redisInitPromise = null; // 追踪初始化 Promise
        this.isRedisInitializing = false; // 明确的状态标志
        this.heartbeatTimer = null; // 心跳定时器

        // 关键修复：绑定 this 上下文，防止异步回调中丢失
        this._handleAuthFailure = this._handleAuthFailure.bind(this);
        this._restartRedisClient = this._restartRedisClient.bind(this);

        // 1. 先设置提供商优先级
        this._setDefaultProvider();

        // 2. 如果选择了 redis，则初始化它
        if (this.currentProvider === 'redis') {
            this._initRedis();
        }

        // 设置便利属性
        this.useRedis = this.currentProvider === 'redis';
        this.useUpstash = this.currentProvider === 'upstash';

        // 🔍 DEBUG: Cache 配置诊断日志

        logger.info('[CacheService DEBUG] 配置诊断:', {
            hasRedis: this.hasRedis,
            hasCloudflare: this.hasCloudflare,
            hasUpstash: this.hasUpstash,
            currentProvider: this.currentProvider,
            cf_accountId_exists: !!this.accountId,
            cf_namespaceId_exists: !!this.namespaceId,
            cf_token_exists: !!this.token,
            apiUrl_set: !!this.apiUrl,
            redisUrl_exists: !!this.redisUrl,
            redisHost_exists: !!this.redisHost,
            upstashUrl_exists: !!this.upstashUrl,
            cache_provider_env: process.env.CACHE_PROVIDER || 'unset',
            env_vars_detected: {
                CF_CACHE_ACCOUNT_ID: !!process.env.CF_CACHE_ACCOUNT_ID,
                CF_KV_ACCOUNT_ID: !!process.env.CF_KV_ACCOUNT_ID,
                CF_ACCOUNT_ID: !!process.env.CF_ACCOUNT_ID,
                CF_CACHE_NAMESPACE_ID: !!process.env.CF_CACHE_NAMESPACE_ID,
                CF_KV_NAMESPACE_ID: !!process.env.CF_KV_NAMESPACE_ID,
                CF_CACHE_TOKEN: !!process.env.CF_CACHE_TOKEN,
                CF_KV_TOKEN: !!process.env.CF_KV_TOKEN,
                CF_D1_TOKEN: !!process.env.CF_D1_TOKEN,
                NF_REDIS_URL: !!process.env.NF_REDIS_URL,
                REDIS_URL: !!process.env.REDIS_URL,
                UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL
            }
        });
    }

    /**
     * 动态初始化 Redis 客户端
     * 在不支持 TCP 的环境中不会导致崩溃
     */
    async _initRedis() {
        if (!this.hasRedis) {
            logger.info(`[${this.getCurrentProvider()}] ℹ️ 未配置 Redis，跳过初始化`);
            return;
        }

        // 防止重复初始化
        if (this.isRedisInitializing && this.redisInitPromise) {
            return this.redisInitPromise;
        }

        this.isRedisInitializing = true;

        // 创建一个新的 Promise 赋值给 this.redisInitPromise
        this.redisInitPromise = (async () => {
            try {
                // 检测是否在 Node.js 环境
                if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ 非 Node.js 环境，无法使用标准 Redis 客户端`);
                    this.isRedisInitializing = false;
                    return;
                }

                // 🔍 预连接验证：检查配置有效性
                const validationError = await this._validateRedisConfig();
                if (validationError) {
                    logger.error(`[${this.getCurrentProvider()}] 🚨 Redis 配置验证失败: ${validationError}`);
                    // 配置无效，直接故障转移
                    this.isRedisInitializing = false;
                    await this._handleAuthFailure();
                    return;
                }

                // 动态导入 ioredis - 添加超时控制
                const importPromise = import('ioredis');
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('ioredis import timeout after 10 seconds')), 10000)
                );

                const ioredisModule = await Promise.race([importPromise, timeoutPromise]);
                const Redis = ioredisModule.default;
                
                // 关键：统一使用 config/index.js 中的配置生成逻辑
                const { getRedisConnectionConfig } = await import("../config/index.js");
                const { url, options: redisOptions } = getRedisConnectionConfig();

                // 在测试环境下，限制重试次数和连接超时，防止异步泄漏
                if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
                    redisOptions.maxRetriesPerRequest = 0;
                    redisOptions.retryStrategy = () => null;
                    redisOptions.connectTimeout = 500; // 快速超时
                }

                // 记录Redis配置信息（用于诊断）
                if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                    console.log(`[CacheService] 🔄 Redis 客户端初始化...`, {
                        url: url ? 'PRESENT' : 'MISSING',
                        host: redisOptions.host,
                        port: redisOptions.port,
                        tlsEnabled: !!redisOptions.tls,
                        servername: redisOptions.tls?.servername
                    });
                }
                logger.info(`[${this.getCurrentProvider()}] 🔄 Redis 客户端初始化...`, {
                    hasUrl: !!url,
                    hasHost: !!redisOptions.host,
                    port: redisOptions.port,
                    hasPassword: !!redisOptions.password,
                    tlsEnabled: !!redisOptions.tls,
                    servername: redisOptions.tls?.servername,
                    family: redisOptions.family,
                    node_env: process.env.NODE_ENV
                });

                // 实例化客户端
                if (redisOptions.tls) {
                    // 加密连接优先使用 options 对象实例化，避免 URL 字符串导致的协议解析冲突
                    this.redisClient = new Redis(redisOptions);
                    this.redisHost = redisOptions.host;
                    this.redisPort = redisOptions.port;
                } else if (url) {
                    // 必须传入 options 以支持配置，否则 new Redis(url) 会忽略 options
                    this.redisClient = new Redis(url, redisOptions);
                    // 关键修复：确保 CacheService 实例上的 host/port 被正确同步
                    this.redisHost = redisOptions.host || this.redisHost;
                    this.redisPort = redisOptions.port || this.redisPort;
                } else {
                    this.redisClient = new Redis(redisOptions);
                    this.redisHost = redisOptions.host;
                    this.redisPort = redisOptions.port;
                }

                // 连接事件监听 (增强诊断)
                this.redisClient.on('connect', () => {
                    this.connectTime = Date.now();
                    const displayHost = this.redisHost || (url ? 'from-url' : 'unknown');
                    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                        logger.debug(`[CacheService] ✅ Redis CONNECT: ${displayHost}:${this.redisPort}`);
                    }
                    logger.info(`[${this.getCurrentProvider()}] ✅ Redis CONNECT: ${displayHost}:${this.redisPort} at ${new Date(this.connectTime).toISOString()}`, {
                        host: this.redisHost,
                        port: this.redisPort,
                        url: url ? 'configured' : 'not configured',
                        hasPassword: !!redisOptions.password,
                        node_env: process.env.NODE_ENV,
                        platform: process.platform
                    });
                });

                this.redisClient.on('ready', () => {
                    const connectDuration = Date.now() - this.connectTime;
                    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                        logger.debug(`[CacheService] ✅ Redis READY: Connection established in ${connectDuration}ms`);
                    }
                    logger.info(`[${this.getCurrentProvider()}] ✅ Redis READY: Connection established in ${connectDuration}ms`, {
                        totalConnections: this.redisClient.options?.maxRetriesPerRequest || 'unknown',
                        connectTimeout: this.redisClient.options?.connectTimeout || 'unknown'
                    });
                    // Resolve any pending waitForReady promises
                    if (this._readyResolver) {
                        this._readyResolver();
                        this._readyResolver = null;
                    }
                });

                this.redisClient.on('reconnecting', (ms) => {
                    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                        logger.warn(`[CacheService] 🔄 Redis RECONNECTING: Attempting reconnection in ${ms}ms`);
                    }
                    logger.warn(`[${this.getCurrentProvider()}] 🔄 Redis RECONNECTING: Attempting reconnection in ${ms}ms`, {
                        lastError: this.lastError,
                        failureCount: this.failureCount,
                        currentProvider: this.currentProvider
                    });
                });

                this.redisClient.on('error', (error) => {
                    const now = Date.now();
                    const uptime = this.connectTime ? Math.round((now - this.connectTime) / 1000) : 0;
                    const errorMsg = error.message || '';
                    const errorCode = error.code || '';
                    
                    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                        logger.error(`[CacheService] 🚨 Redis ERROR: ${errorMsg}`, {
                            code: errorCode,
                            host: error.hostname || error.address,
                            port: error.port
                        });
                    }
                    
                    // 增强错误日志：暴露具体错误但不泄露凭证
                    const safeError = {
                        message: errorMsg,
                        code: errorCode,
                        errno: error.errno,
                        syscall: error.syscall,
                        hostname: error.hostname,
                        port: error.port,
                        address: error.address,
                        uptime: `${uptime}s`,
                        node_env: process.env.NODE_ENV,
                        platform: process.platform,
                        stack: error.stack?.split('\n')[0]
                    };
                    
                    // 移除可能包含凭证的敏感信息
                    if (safeError.message) {
                        safeError.message = safeError.message.replace(/password=[^&\s]*/g, 'password=***');
                        safeError.message = safeError.message.replace(/token=[^&\s]*/g, 'token=***');
                        safeError.message = safeError.message.replace(/Bearer [^\s]*/g, 'Bearer ***');
                    }
                    
                    logger.error(`[${this.getCurrentProvider()}] 🚨 Redis ERROR: ${safeError.message}`, safeError);
                    this.lastRedisError = errorMsg;
                    
                    // 关键：检测 WRONGPASS 和各种认证错误
                    const authErrorPatterns = [
                        'WRONGPASS',
                        'authentication failed',
                        'invalid password',
                        'NOAUTH',
                        'WRONGPASS invalid username-password pair',
                        'Client sent AUTH, but no password is set',
                        'Operation not permitted',
                        'ERR invalid password',
                        'ERR AUTH <password> called without any password configured'
                    ];
                    
                    const isAuthError = authErrorPatterns.some(pattern =>
                        errorMsg.includes(pattern) || errorCode.includes(pattern)
                    );
                    
                    if (isAuthError) {
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Redis 认证失败检测到，准备故障转移`, {
                            error: errorMsg,
                            code: errorCode,
                            recommendation: '检查 Redis 密码/凭证配置',
                            action: '触发故障转移至后备提供商'
                        });
                        // 触发故障转移
                        this._handleAuthFailure();
                    } else if (errorMsg.includes('free usage limit') || errorMsg.includes('quota exceeded')) {
                        // Upstash 配额错误也触发故障转移
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 配额限制，准备故障转移`, {
                            error: errorMsg
                        });
                        this._handleAuthFailure();
                    }
                });

                this.redisClient.on('close', async () => {
                    const now = Date.now();
                    const duration = this.connectTime ? now - this.connectTime : 0;
                    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                        logger.warn(`[CacheService] ⚠️ Redis CLOSE: Connection closed after ${Math.round(duration / 1000)}s`);
                    }
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis CLOSE: Connection closed after ${Math.round(duration / 1000)}s`, {
                        durationMs: duration,
                        lastError: this.lastRedisError || 'none',
                        failureCount: this.failureCount,
                        currentProvider: this.currentProvider,
                        hasPassword: !!this.redisPassword,
                        node_env: process.env.NODE_ENV,
                        platform: process.platform
                    });
                    
                    // 不再立即清理心跳或触发重启，让 ioredis 自动重连
                    // 只有在明确收到 'end' 事件时才考虑重启或降级
                });

                // 添加更多诊断事件
                this.redisClient.on('wait', () => {
                    logger.debug(`[${this.getCurrentProvider()}] 🔄 Redis WAIT: Command queued, waiting for connection`);
                });

                this.redisClient.on('end', async () => {
                    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'diagnostic') {
                        logger.warn(`[CacheService] ⚠️ Redis END: Connection ended by client`);
                    }
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis END: Connection ended by client`);
                    // 触发自动重启 (如果未被销毁)
                    if (!this.destroyed) {
                        setTimeout(() => this._restartRedisClient(), 1000);
                    }
                });

                this.redisClient.on('select', (db) => {
                    logger.debug(`[${this.getCurrentProvider()}] 🔄 Redis SELECT: Database ${db} selected`);
                });

                // 异步测试连接，不阻塞初始化 - 避免卡死
                (async () => {
                    const pingStart = Date.now();
                    try {
                        const pingPromise = this.redisClient.ping();
                        const timeoutPromise = new Promise((_, reject) => {
                            const t = setTimeout(() => reject(new Error('Redis ping timeout after 10 seconds')), 10000);
                            if (t.unref) t.unref(); // 允许测试环境下快速结束
                        });

                        const pingResult = await Promise.race([pingPromise, timeoutPromise]);
                        const pingDuration = Date.now() - pingStart;

                        logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：使用 Northflank Redis`, {
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
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis ping 测试失败，但继续初始化以支持延迟连接`, {
                            error: pingError.message,
                            durationMs: pingDuration,
                            clientStatus: this.redisClient ? this.redisClient.status : 'null',
                            node_env: process.env.NODE_ENV,
                            platform: process.platform
                        });

                        // 即使 ping 失败，也启动心跳机制（延迟连接时有用）
                        this._startHeartbeat();
                    }
                })();

                this.isRedisInitializing = false;
            } catch (error) {
                logger.error(`[${this.getCurrentProvider()}] 🚨 Redis 初始化失败: ${error.message}`);
                this.redisClient = null;
                this.isRedisInitializing = false;
                throw error;
            }
        })();

        return this.redisInitPromise;
    }

    /**
     * 预连接验证：检查 Redis 配置有效性
     * 在建立连接前验证凭证，捕获 WRONGPASS 错误
     * @returns {string|null} - 如果验证失败返回错误信息，否则返回 null
     */
    async _validateRedisConfig() {
        try {
            // 获取配置
            const { getRedisConnectionConfig } = await import("../config/index.js");
            const { url, options: redisOptions } = getRedisConnectionConfig();

            // 检查基本配置
            if (!url && !redisOptions.host) {
                return "Redis URL 或 Host 未配置";
            }

            // 检查密码（如果需要认证）
            if (!redisOptions.password && !redisOptions.url?.includes('@')) {
                logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis 配置未提供密码，可能无法连接到需要认证的实例`);
                // 不返回错误，允许尝试连接（可能连接到不需要密码的实例）
            }

            // 对于 Upstash，验证 URL 和 Token 格式
            if (this.currentProvider === 'upstash' || this.upstashUrl) {
                if (!this.upstashUrl || !this.upstashToken) {
                    return "Upstash 配置不完整（缺少 URL 或 Token）";
                }
                
                // 验证 Upstash URL 格式
                if (!this.upstashUrl.includes('upstash.io')) {
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash URL 格式异常: ${this.upstashUrl}`);
                }
            }

            // 尝试快速连接测试（仅用于认证验证）
            if (process.env.NODE_ENV !== 'test') {
                const testResult = await this._testRedisConnection();
                if (!testResult.success) {
                    return testResult.error;
                }
            }

            return null; // 验证通过
        } catch (error) {
            logger.error(`[${this.getCurrentProvider()}] 🚨 配置验证异常: ${error.message}`);
            return `配置验证异常: ${error.message}`;
        }
    }

    /**
     * 快速连接测试 - 用于预验证认证
     * @returns {Promise<{success: boolean, error: string|null}>}
     */
    async _testRedisConnection() {
        try {
            // 对于 Upstash，使用快速的 GET 请求测试认证
            if (this.currentProvider === 'upstash' || this.upstashUrl) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒超时

                const response = await fetch(`${this.upstashUrl}/get/__test_auth__`, {
                    method: "GET",
                    headers: {
                        "Authorization": `Bearer ${this.upstashToken}`,
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                // 检查认证错误
                if (response.status === 401 || response.status === 403) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorMsg = errorData.error || `HTTP ${response.status}: 认证失败`;
                    
                    logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证测试失败: ${errorMsg}`);
                    return { success: false, error: `Upstash 认证失败: ${errorMsg}` };
                }

                // 其他状态码（如 404）表示认证成功但键不存在，这是正常的
                return { success: true, error: null };
            }

            // 对于标准 Redis，使用 ping 测试
            if (this.currentProvider === 'redis' && this.hasRedis) {
                // 这里我们不实际创建客户端，只是验证配置存在
                // 真正的连接测试在 _initRedis 中进行
                return { success: true, error: null };
            }

            return { success: true, error: null };
        } catch (error) {
            // 网络错误或超时
            if (error.name === 'AbortError' || error.name === 'TypeError' && error.message.includes('fetch')) {
                logger.warn(`[${this.getCurrentProvider()}] ⚠️ 连接测试超时或网络错误: ${error.message}`);
                // 不视为认证失败，可能是网络问题
                return { success: true, error: null };
            }

            logger.error(`[${this.getCurrentProvider()}] 🚨 连接测试异常: ${error.message}`);
            return { success: false, error: `连接测试失败: ${error.message}` };
        }
    }

    /**
     * 处理认证失败 - 捕获 WRONGPASS 并触发故障转移
     */
    async _handleAuthFailure() {
        logger.error(`[${this.getCurrentProvider()}] 🚨 检测到 Redis 认证失败，立即触发故障转移`);
        
        // 增加失败计数，确保触发故障转移
        this.failureCount = Math.max(this.failureCount, 2);
        this.lastError = 'Redis authentication failed (WRONGPASS)';
        
        // 立即清理当前客户端
        if (this.redisClient) {
            try {
                await this.redisClient.quit().catch(() => {});
            } catch (e) {
                // 忽略 quit 错误
            }
            this.redisClient.removeAllListeners();
            this.redisClient = null;
        }
        
        // 停止心跳
        if (typeof this.stopHeartbeat === 'function') {
            this.stopHeartbeat();
        }
        
        // 触发故障转移
        if (this._failover()) {
            logger.info(`[${this.getCurrentProvider()}] ✅ 已从认证失败的 Redis 故障转移到 ${this.getCurrentProvider()}`);
        } else {
            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 无可用后备提供商，将使用本地缓存`);
        }
    }

    /**
     * 重启 Redis 客户端 - 从 'end' 状态恢复
     */
    async _restartRedisClient() {
        if (this.restarting || this.destroyed) {
            logger.debug(`[${this.getCurrentProvider()}] 🔄 Redis 重启已在进行中或实例已销毁，跳过重复调用`);
            return;
        }
        
        this.restarting = true;
        try {
            logger.info(`[${this.getCurrentProvider()}] 🔄 Redis 客户端重启中...`);
            
            // 清理现有客户端
            if (this.redisClient) {
                try {
                    await this.redisClient.quit().catch(() => {});
                } catch (e) {
                    // 忽略 quit 错误
                }
                this.redisClient.removeAllListeners();
                this.redisClient = null;
            }
            
            // 停止心跳
            if (typeof this.stopHeartbeat === 'function') {
                this.stopHeartbeat();
            }
            
            // 等待延迟（可配置）
            const restartDelay = parseInt(process.env.REDIS_RESTART_DELAY) || 5000;
            logger.info(`[${this.getCurrentProvider()}] 🔄 等待 ${restartDelay}ms 后重新初始化 Redis...`);
            await new Promise(resolve => setTimeout(resolve, restartDelay));
            
            // 重新初始化
            await this._initRedis();
            
            logger.info(`[${this.getCurrentProvider()}] ✅ Redis 客户端重启完成`);
        } catch (error) {
            logger.error(`[${this.getCurrentProvider()}] 🚨 Redis 重启失败: ${error.message}`);
        } finally {
            this.restarting = false;
        }
    }

    /**
     * 辅助方法：等待 Redis 初始化完成
     * @param {number} timeoutMs - 超时时间（毫秒）
     */
    async _waitForRedisInit(timeoutMs = 2000) {
        const startTime = Date.now();
        
        // 如果有 active promise，等待它
        if (this.redisInitPromise) {
            try {
                await Promise.race([
                    this.redisInitPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Init timeout')), timeoutMs))
                ]);
            } catch (e) {
                // 忽略 promise 本身的错误，我们只关心是否超时或完成
            }
        }
        
        // 轮询检查 client 是否 ready (处理 restartDelay 期间没有 promise 的情况)
        while (!this.redisClient && (Date.now() - startTime < timeoutMs)) {
            await new Promise(r => setTimeout(r, 100));
        }
        
        if (!this.redisClient) {
            throw new Error('Redis client still null after wait');
        }
    }

    /**
     * 检查 Redis 连接健康状态
     */
    _checkRedisHealth() {
        if (!this.redisClient) return false;
        
        const status = this.redisClient.status;
        // 只有 ready 状态才认为健康
        return status === 'ready';
    }

    /**
     * 主动触发 Redis 连接检查
     */
    async _validateRedisConnection() {
        if (!this.redisClient || !this.hasRedis) {
            return false;
        }
        
        try {
            // 使用带超时的 ping
            const pingPromise = this.redisClient.ping();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Health check timeout')), 5000)
            );
            
            await Promise.race([pingPromise, timeoutPromise]);
            return true;
        } catch (error) {
            logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis 健康检查失败`, {
                error: error.message,
                status: this.redisClient ? this.redisClient.status : 'null'
            });
            return false;
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
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：强制使用 Northflank Redis`);
            } else if (provider === 'cloudflare' && this.hasCloudflare) {
                this.currentProvider = 'cloudflare';
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：强制使用 Cloudflare KV`);
            } else if (provider === 'upstash' && this.hasUpstash) {
                this.currentProvider = 'upstash';
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：强制使用 Upstash Redis`);
            } else {
                throw new Error(`强制使用 ${provider}，但该提供商未配置完整`);
            }
        } else {
            // 自动选择优先级
            if (this.hasRedis) {
                this.currentProvider = 'redis';
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：使用 Northflank Redis`);
            } else if (this.hasCloudflare) {
                this.currentProvider = 'cloudflare';
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：使用 Cloudflare KV`);
            } else if (this.hasUpstash) {
                this.currentProvider = 'upstash';
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：使用 Upstash Redis`);
            } else {
                // 默认使用 cloudflare (即使配置不完整，这也是系统设计的最终回退)
                this.currentProvider = 'cloudflare';
                logger.info(`[${this.getCurrentProvider()}] 🔄 Cache服务：未配置任何提供商，回退到 Cloudflare KV (默认)`);
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

            // 连续2次错误即触发故障转移（降低阈值）
            if (this.failureCount >= 2) {
                const targets = this._calculateFailoverTargets();
                if (targets.length > 0) {
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ 连续失败 ${this.failureCount} 次，触发自动故障转移到 ${targets[0]}`);
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

        logger.info(`[${this.getCurrentProvider()}] ✅ 已切换到 ${this._getProviderDisplayName(nextProvider)}`);
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
        logger.info(`[${this.getCurrentProvider()}] 🕒 启动 Cache 恢复检查，间隔: ${checkInterval / 60000} 分钟`);

        this.recoveryTimer = setInterval(async () => {
            // 根据当前提供商决定恢复目标
            if (this.currentProvider === 'upstash') {
                // 从 Upstash 恢复到 Cloudflare
                try {
                    await this._cloudflare_get('__health_check__');
                    logger.info(`[${this.getCurrentProvider()}] 🔄 Cloudflare KV 已恢复，切换回主要提供商...`);
                    this.currentProvider = 'cloudflare';
                    this.failureCount = 0;
                    this.lastError = null;

                    // 清理恢复检查定时器
                    if (this.recoveryTimer) {
                        clearInterval(this.recoveryTimer);
                        this.recoveryTimer = null;
                    }

                    logger.info(`[${this.getCurrentProvider()}] ✅ 已恢复到 Cloudflare KV`);
                } catch (error) {
                    // 恢复失败，继续使用当前提供商
                    logger.info(`[${this.getCurrentProvider()}] ℹ️ Cloudflare KV 仍不可用，继续使用 Upstash`);
                }
            } else if (this.currentProvider === 'cloudflare' && this.hasRedis) {
                // 从 Cloudflare 恢复到 Redis（如果 Redis 可用）
                try {
                    if (this.redisClient) {
                        await this.redisClient.ping();
                        logger.info(`[${this.getCurrentProvider()}] 🔄 Northflank Redis 已恢复，切换回主要提供商...`);
                        this.currentProvider = 'redis';
                        this.failureCount = 0;
                        this.lastError = null;

                        // 清理恢复检查定时器
                        if (this.recoveryTimer) {
                            clearInterval(this.recoveryTimer);
                            this.recoveryTimer = null;
                        }

                        logger.info(`[${this.getCurrentProvider()}] ✅ 已恢复到 Northflank Redis`);
                    }
                } catch (error) {
                    // 恢复失败，继续使用当前提供商
                    logger.info(`[${this.getCurrentProvider()}] ℹ️ Northflank Redis 仍不可用，继续使用当前提供商`);
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
        if (!error) return false;
        
        const msg = (error.message || "").toLowerCase();
        const status = error.status || error.code || "";
        
        // Upstash 特定错误
        const upstashErrors = [
            'free usage limit',
            'quota exceeded',
            'rate limit',
            'too many requests',
            '429',
            'daily limit exceeded'
        ];
        
        // 网络/连接错误
        const networkErrors = [
            'fetch failed',
            'network',
            'timeout',
            'network timeout',
            'connection',
            'econnreset',
            'econnrefused',
            'getaddrinfo',
            'redis client not in ready state',
            'client not in ready state'
        ];
        
        // 检查所有可能的错误类型
        return upstashErrors.some(e => msg.includes(e) || status.toString().includes(e)) ||
               networkErrors.some(e => msg.includes(e) || status.toString().includes(e));
    }

    /**
     * 执行操作并支持故障转移
     */
    async _executeWithFailover(operation, ...args) {
        // 1. Redis 客户端不可用或处于断开状态时的 Fallback
        if (this.currentProvider === 'redis') {
            // 场景 1: 客户端为 null，但正在初始化/重启
            if (!this.redisClient && (this.isRedisInitializing || this.restarting)) {
                logger.info(`[CacheService] ⏳ Redis 正在初始化/重启，请求等待中...`);
                try {
                    // 等待初始化完成，或者超时（例如 2000ms）
                    await this._waitForRedisInit(2000);
                } catch (e) {
                    logger.warn(`[CacheService] ⚠️ 等待 Redis 初始化超时: ${e.message}`);
                    // 超时后继续执行，将触发下方的 fallback 逻辑
                }
            }

            // 优化：不再对 close 或 end 立即降级，因为 ioredis 会尝试重连
            // 只有当 redisClient 为 null 时（未初始化）才降级
            if (!this.redisClient) {
                logger.warn(`[${this.getCurrentProvider()}] Redis client is null, fallback immediately`);
                return await this._fallbackToNextProvider(operation, ...args);
            }
            
            // 如果处于 reconnecting 状态，我们继续尝试执行，让 ioredis 的队列机制处理
            // 但如果 status 是 end，说明已经彻底放弃重连，需要 fallback
            if (this.redisClient.status === 'end') {
                logger.warn(`[${this.getCurrentProvider()}] Redis client status is end, fallback immediately`);
                return await this._fallbackToNextProvider(operation, ...args);
            }
        }

        // 2. 主动健康检查 (仅对 Redis)
        if (this.currentProvider === 'redis' && this.redisClient?.status === 'ready') {
            const isHealthy = await this._validateRedisConnection();
            if (!isHealthy) {
                logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis 健康检查失败，主动触发 failover`);
                return await this._fallbackToNextProvider(operation, ...args);
            }
        }

        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                if (this.currentProvider === 'redis') {
                    // 再次检查客户端状态
                    if (!this.redisClient || this.redisClient.status === 'close' || this.redisClient.status === 'end') {
                        throw new Error('Redis client not in ready state');
                    }
                    return await this[`_redis_${operation}`](...args);
                } else if (this.currentProvider === 'upstash') {
                    return await this[`_upstash_${operation}`](...args);
                } else {
                    return await this[`_cloudflare_${operation}`](...args);
                }
            } catch (error) {
                attempts++;
                logger.warn(`[${this.getCurrentProvider()}] ⚠️ 操作失败 (${attempts}/${maxAttempts})`, {
                    operation,
                    error: error.message,
                    clientStatus: this.redisClient?.status
                });

                // 3. 判断是否需要 Failover
                if (this._shouldFailover(error)) {
                    logger.info(`[${this.getCurrentProvider()}] 🔄 检测到可恢复错误，准备故障转移`, {
                        currentProvider: this.currentProvider,
                        failureCount: this.failureCount,
                        lastError: error.message,
                        errorType: this._isRetryableError(error) ? 'retryable' : 'non-retryable'
                    });
                    
                    if (this._failover()) {
                        logger.info(`[${this.getCurrentProvider()}] ✅ 故障转移成功，现在使用 ${this.getCurrentProvider()}`);
                        // 重置尝试次数，使用新提供商
                        attempts = 0;
                        continue;
                    } else {
                        logger.warn(`[${this.getCurrentProvider()}] ❌ 故障转移失败，无可用后备提供商`);
                    }
                }

                // 4. 非可重试错误或达到最大尝试次数，抛出异常
                if (!this._isRetryableError(error) || attempts >= maxAttempts) {
                    throw error;
                }
                
                logger.info(`[${this.getCurrentProvider()}] ℹ️ 重试中 (${attempts}/${maxAttempts})...`);
            }
        }
    }

    /**
     * 优雅降级到下一个提供商
     */
    async _fallbackToNextProvider(operation, ...args) {
        const originalProvider = this.currentProvider;
        
        // 计算下一个可用提供商
        const targets = this._calculateFailoverTargets();
        if (targets.length === 0) {
            // 没有可用后备，使用本地缓存
            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 无可用后备提供商，使用本地缓存`);
            return await this._local_cache_operation(operation, ...args);
        }
        
        // 执行故障转移
        if (this._failover()) {
            logger.info(`[${this.getCurrentProvider()}] 🔄 已从 ${this._getProviderDisplayName(originalProvider)} 降级到 ${this.getCurrentProvider()}`);
            // 使用新提供商重试
            return await this._executeWithFailover(operation, ...args);
        }
        
        throw new Error(`无法从 ${this._getProviderDisplayName(originalProvider)} 故障转移`);
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
                logger.debug(`[${this.getCurrentProvider()}] 🔍 Redis GET: Key '${key}' not found`, {
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
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis GET: JSON parse failed for key '${key}', returning raw value`, {
                        error: e.message,
                        durationMs: duration
                    });
                    parsedValue = value;
                }
            } else {
                parsedValue = value;
            }

            logger.debug(`[${this.getCurrentProvider()}] ✅ Redis GET: Key '${key}' retrieved`, {
                durationMs: duration,
                valueSize: value.length,
                parsedType: type
            });

            return parsedValue;
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`[${this.getCurrentProvider()}] 🚨 Redis GET failed for key '${key}'`, {
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
                    logger.debug(`[${this.getCurrentProvider()}] ✅ Redis SET with TTL: Key '${key}' set`, {
                        durationMs: Date.now() - startTime,
                        ttlSeconds: ttl,
                        valueSize: valueStr.length,
                        clientStatus: this.redisClient.status
                    });
                } else if (ttl !== 0) {
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis SET: Invalid TTL value ${expirationTtl}, skipping expiration (${key})`, {
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
            logger.debug(`[${this.getCurrentProvider()}] ✅ Redis SET: Key '${key}' set successfully`, {
                durationMs: duration,
                valueSize: valueStr.length,
                hasTtl: expirationTtl !== null,
                result
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error(`[${this.getCurrentProvider()}] 🚨 Redis SET failed for key '${key}'`, {
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

        // Handle undefined response (for mock fetch)
        if (!response || !response.json) {
            throw new Error('Cache Set Error: Invalid response from Cloudflare KV');
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Cache Set Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash set 实现 - 增强错误处理和重试
     */
    async _upstash_set(key, value, expirationTtl = null) {
        return await upstashRateLimiter.execute(async () => {
            const valueStr = typeof value === "string" ? value : JSON.stringify(value);

            const command = ["SET", key, valueStr];

            if (expirationTtl !== null && expirationTtl !== undefined) {
                const ttl = parseInt(expirationTtl, 10);
                if (!isNaN(ttl) && ttl > 0) {
                    command.push("EX", ttl.toString());
                } else if (ttl !== 0) {
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash set: 无效的 TTL 值 ${expirationTtl}，跳过过期设置 (${key})`);
                }
            }

            const maxRetries = 3;
            let lastError;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${this.upstashUrl}/`, {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${this.upstashToken}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(command),
                    });

                    // 检查认证错误 (401/403)
                    if (response.status === 401 || response.status === 403) {
                        const errorData = await response.json().catch(() => ({}));
                        const errorMsg = errorData.error || `HTTP ${response.status}: 认证失败`;
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证失败: ${errorMsg}`);
                        // 立即触发故障转移，不重试
                        await this._handleAuthFailure();
                        throw new Error(`Upstash 认证失败: ${errorMsg}`);
                    }

                    // 检查速率限制响应
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After');
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 速率限制，等待 ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        if (attempt < maxRetries) continue;
                        throw new Error('Upstash rate limit exceeded');
                    }

                    // 检查配额错误
                    if (response.status === 402 || response.status === 429) {
                        const errorData = await response.json().catch(() => ({}));
                        if (errorData.error && (errorData.error.includes('limit') || errorData.error.includes('quota'))) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 配额限制: ${errorData.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 配额限制: ${errorData.error}`);
                        }
                    }

                    // Handle undefined response (for mock fetch)
                    if (!response || !response.json) {
                        throw new Error('Upstash Set Error: Invalid response');
                    }

                    const result = await response.json();
                    if (result.error) {
                        // 检查是否是认证相关的错误
                        if (result.error.includes('auth') || result.error.includes('token') || result.error.includes('permission')) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证错误: ${result.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 认证错误: ${result.error}`);
                        }
                        
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash Set Error for key '${key}':`, result.error);
                        throw new Error(`Upstash Set Error: ${result.error}`);
                    }
                    return result.result === "OK";
                } catch (error) {
                    lastError = error;
                    
                    // 网络错误，重试
                    if (error.message.includes('fetch failed') ||
                        error.message.includes('network') ||
                        error.message.includes('timeout') ||
                        error.code === 'ECONNRESET' ||
                        error.code === 'ECONNREFUSED') {
                        
                        if (attempt < maxRetries) {
                            const waitTime = 1000 * attempt; // 指数退避
                            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 网络错误，第 ${attempt}/${maxRetries} 次重试，等待 ${waitTime}ms`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        }
                    }
                    
                    // 认证错误不重试
                    if (error.message.includes('认证失败') || error.message.includes('auth')) {
                        throw error;
                    }
                    
                    // 其他错误，如果还有重试次数则重试
                    if (attempt < maxRetries) {
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 操作失败，第 ${attempt}/${maxRetries} 次重试: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    
                    throw lastError;
                }
            }
            
            throw lastError;
        });
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

        // Handle undefined response (for mock fetch)
        if (!response || !response.json) {
            throw new Error('Cache Get Error: Invalid response from Cloudflare KV');
        }

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
     * Upstash get 实现 - 增强错误处理和重试
     */
    async _upstash_get(key, type = "json") {
        return await upstashRateLimiter.execute(async () => {
            const maxRetries = 3;
            let lastError;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${this.upstashUrl}/get/${encodeURIComponent(key)}`, {
                        method: "GET",
                        headers: {
                            "Authorization": `Bearer ${this.upstashToken}`,
                        },
                    });

                    // 检查认证错误 (401/403)
                    if (response.status === 401 || response.status === 403) {
                        const errorData = await response.json().catch(() => ({}));
                        const errorMsg = errorData.error || `HTTP ${response.status}: 认证失败`;
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证失败: ${errorMsg}`);
                        await this._handleAuthFailure();
                        throw new Error(`Upstash 认证失败: ${errorMsg}`);
                    }

                    // 检查速率限制响应
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After');
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 速率限制，等待 ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        if (attempt < maxRetries) continue;
                        throw new Error('Upstash rate limit exceeded');
                    }

                    // 检查配额错误
                    if (response.status === 402 || response.status === 429) {
                        const errorData = await response.json().catch(() => ({}));
                        if (errorData.error && (errorData.error.includes('limit') || errorData.error.includes('quota'))) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 配额限制: ${errorData.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 配额限制: ${errorData.error}`);
                        }
                    }

                    // Handle undefined response (for mock fetch)
                    if (!response || !response.json) {
                        throw new Error('Upstash Get Error: Invalid response');
                    }

                    const result = await response.json();
                    if (result.error) {
                        // 检查是否是认证相关的错误
                        if (result.error.includes('auth') || result.error.includes('token') || result.error.includes('permission')) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证错误: ${result.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 认证错误: ${result.error}`);
                        }
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
                } catch (error) {
                    lastError = error;
                    
                    // 认证错误不重试
                    if (error.message.includes('认证失败') || error.message.includes('auth')) {
                        throw error;
                    }
                    
                    // 网络错误，重试
                    if (error.message.includes('fetch failed') ||
                        error.message.includes('network') ||
                        error.message.includes('timeout') ||
                        error.code === 'ECONNRESET' ||
                        error.code === 'ECONNREFUSED') {
                        
                        if (attempt < maxRetries) {
                            const waitTime = 1000 * attempt;
                            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 网络错误，第 ${attempt}/${maxRetries} 次重试，等待 ${waitTime}ms`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        }
                    }
                    
                    if (attempt < maxRetries) {
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 操作失败，第 ${attempt}/${maxRetries} 次重试: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    
                    throw lastError;
                }
            }
            
            throw lastError;
        });
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

        // Handle undefined response (for mock fetch)
        if (!response || !response.json) {
            throw new Error('Cache Delete Error: Invalid response from Cloudflare KV');
        }

        const result = await response.json();
        if (!result.success && response.status !== 404) {
            throw new Error(`Cache Delete Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash delete 实现 - 增强错误处理和重试
     */
    async _upstash_delete(key) {
        return await upstashRateLimiter.execute(async () => {
            const maxRetries = 3;
            let lastError;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${this.upstashUrl}/del/${encodeURIComponent(key)}`, {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${this.upstashToken}`,
                        },
                    });

                    // 检查认证错误 (401/403)
                    if (response.status === 401 || response.status === 403) {
                        const errorData = await response.json().catch(() => ({}));
                        const errorMsg = errorData.error || `HTTP ${response.status}: 认证失败`;
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证失败: ${errorMsg}`);
                        await this._handleAuthFailure();
                        throw new Error(`Upstash 认证失败: ${errorMsg}`);
                    }

                    // 检查速率限制响应
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After');
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 速率限制，等待 ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        if (attempt < maxRetries) continue;
                        throw new Error('Upstash rate limit exceeded');
                    }

                    // 检查配额错误
                    if (response.status === 402 || response.status === 429) {
                        const errorData = await response.json().catch(() => ({}));
                        if (errorData.error && (errorData.error.includes('limit') || errorData.error.includes('quota'))) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 配额限制: ${errorData.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 配额限制: ${errorData.error}`);
                        }
                    }

                    // Handle undefined response (for mock fetch)
                    if (!response || !response.json) {
                        throw new Error('Upstash Delete Error: Invalid response');
                    }

                    const result = await response.json();
                    if (result.error) {
                        // 检查是否是认证相关的错误
                        if (result.error.includes('auth') || result.error.includes('token') || result.error.includes('permission')) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证错误: ${result.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 认证错误: ${result.error}`);
                        }
                        throw new Error(`Upstash Delete Error: ${result.error}`);
                    }
                    return result.result > 0;
                } catch (error) {
                    lastError = error;
                    
                    // 认证错误不重试
                    if (error.message.includes('认证失败') || error.message.includes('auth')) {
                        throw error;
                    }
                    
                    // 网络错误，重试
                    if (error.message.includes('fetch failed') ||
                        error.message.includes('network') ||
                        error.message.includes('timeout') ||
                        error.code === 'ECONNRESET' ||
                        error.code === 'ECONNREFUSED') {
                        
                        if (attempt < maxRetries) {
                            const waitTime = 1000 * attempt;
                            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 网络错误，第 ${attempt}/${maxRetries} 次重试，等待 ${waitTime}ms`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        }
                    }
                    
                    if (attempt < maxRetries) {
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 操作失败，第 ${attempt}/${maxRetries} 次重试: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    
                    throw lastError;
                }
            }
            
            throw lastError;
        });
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

        // Handle undefined response (for mock fetch)
        if (!response || !response.json) {
            throw new Error('Cache Bulk Set Error: Invalid response from Cloudflare KV');
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Cache Bulk Set Error: ${result.errors?.[0]?.message || "Unknown error"}`);
        }
        // Cloudflare bulk API doesn't return per-item results, assume all successful
        return pairs.map(() => ({ success: true, result: "OK" }));
    }

    /**
     * Upstash bulkSet 实现 - 增强错误处理和重试
     */
    async _upstash_bulkSet(pairs) {
        return await upstashRateLimiter.execute(async () => {
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

            const maxRetries = 3;
            let lastError;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${this.upstashUrl}/pipeline`, {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${this.upstashToken}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(commands),
                    });

                    // 检查认证错误 (401/403)
                    if (response.status === 401 || response.status === 403) {
                        const errorData = await response.json().catch(() => ({}));
                        const errorMsg = errorData.error || `HTTP ${response.status}: 认证失败`;
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证失败: ${errorMsg}`);
                        await this._handleAuthFailure();
                        throw new Error(`Upstash 认证失败: ${errorMsg}`);
                    }

                    // 检查速率限制响应
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After');
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 速率限制，等待 ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        if (attempt < maxRetries) continue;
                        throw new Error('Upstash rate limit exceeded');
                    }

                    // 检查配额错误
                    if (response.status === 402 || response.status === 429) {
                        const errorData = await response.json().catch(() => ({}));
                        if (errorData.error && (errorData.error.includes('limit') || errorData.error.includes('quota'))) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 配额限制: ${errorData.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 配额限制: ${errorData.error}`);
                        }
                    }

                    // Handle undefined response (for mock fetch)
                    if (!response || !response.json) {
                        throw new Error('Upstash Pipeline Error: Invalid response');
                    }

                    const results = await response.json();
                    if (results.error) {
                        // 检查是否是认证相关的错误
                        if (results.error.includes('auth') || results.error.includes('token') || results.error.includes('permission')) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证错误: ${results.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 认证错误: ${results.error}`);
                        }
                        throw new Error(`Upstash Pipeline Error: ${results.error}`);
                    }
                    const items = results.results || (Array.isArray(results) ? results : [results]);
                    return items.map(r => ({
                        success: !r.error,
                        result: r.error ? r.error : r.result
                    }));
                } catch (error) {
                    lastError = error;
                    
                    // 认证错误不重试
                    if (error.message.includes('认证失败') || error.message.includes('auth')) {
                        throw error;
                    }
                    
                    // 网络错误，重试
                    if (error.message.includes('fetch failed') ||
                        error.message.includes('network') ||
                        error.message.includes('timeout') ||
                        error.code === 'ECONNRESET' ||
                        error.code === 'ECONNREFUSED') {
                        
                        if (attempt < maxRetries) {
                            const waitTime = 1000 * attempt;
                            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 网络错误，第 ${attempt}/${maxRetries} 次重试，等待 ${waitTime}ms`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        }
                    }
                    
                    if (attempt < maxRetries) {
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 操作失败，第 ${attempt}/${maxRetries} 次重试: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    
                    throw lastError;
                }
            }
            
            throw lastError;
        });
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

        // Handle undefined response (for mock fetch)
        if (!response || !response.json) {
            throw new Error('Cache ListKeys Error: Invalid response from Cloudflare KV');
        }

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
     * Upstash listKeys 实现 - 增强错误处理和重试
     */
    async _upstash_listKeys(prefix = '') {
        return await upstashRateLimiter.execute(async () => {
            const maxRetries = 3;
            let lastError;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
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

                    // 检查认证错误 (401/403)
                    if (response.status === 401 || response.status === 403) {
                        const errorData = await response.json().catch(() => ({}));
                        const errorMsg = errorData.error || `HTTP ${response.status}: 认证失败`;
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证失败: ${errorMsg}`);
                        await this._handleAuthFailure();
                        throw new Error(`Upstash 认证失败: ${errorMsg}`);
                    }

                    // 检查速率限制响应
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After');
                        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 速率限制，等待 ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        if (attempt < maxRetries) continue;
                        throw new Error('Upstash rate limit exceeded');
                    }

                    // 检查配额错误
                    if (response.status === 402 || response.status === 429) {
                        const errorData = await response.json().catch(() => ({}));
                        if (errorData.error && (errorData.error.includes('limit') || errorData.error.includes('quota'))) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 配额限制: ${errorData.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 配额限制: ${errorData.error}`);
                        }
                    }

                    // Handle undefined response (for mock fetch)
                    if (!response || !response.json) {
                        throw new Error('Upstash ListKeys Error: Invalid response');
                    }

                    const result = await response.json();
                    if (result.error) {
                        // 检查是否是认证相关的错误
                        if (result.error.includes('auth') || result.error.includes('token') || result.error.includes('permission')) {
                            logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash 认证错误: ${result.error}`);
                            await this._handleAuthFailure();
                            throw new Error(`Upstash 认证错误: ${result.error}`);
                        }
                        logger.error(`[${this.getCurrentProvider()}] 🚨 Upstash ListKeys Error:`, result.error);
                        throw new Error(`Upstash ListKeys Error: ${result.error}`);
                    }

                    return result.result || [];
                } catch (error) {
                    lastError = error;
                    
                    // 认证错误不重试
                    if (error.message.includes('认证失败') || error.message.includes('auth')) {
                        throw error;
                    }
                    
                    // 网络错误，重试
                    if (error.message.includes('fetch failed') ||
                        error.message.includes('network') ||
                        error.message.includes('timeout') ||
                        error.code === 'ECONNRESET' ||
                        error.code === 'ECONNREFUSED') {
                        
                        if (attempt < maxRetries) {
                            const waitTime = 1000 * attempt;
                            logger.warn(`[${this.getCurrentProvider()}] ⚠️ 网络错误，第 ${attempt}/${maxRetries} 次重试，等待 ${waitTime}ms`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        }
                    }
                    
                    if (attempt < maxRetries) {
                        logger.warn(`[${this.getCurrentProvider()}] ⚠️ Upstash 操作失败，第 ${attempt}/${maxRetries} 次重试: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    
                    throw lastError;
                }
            }
            
            throw lastError;
        });
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

        // 在测试环境中不启动心跳，避免异步泄漏
        if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
            return;
        }

        const heartbeatInterval = 30 * 1000; // Northflank环境：30秒间隔（从2分钟减少）
        logger.info(`[${this.getCurrentProvider()}] 🫀 启动 Redis 心跳机制，间隔: ${heartbeatInterval / 1000} 秒 (Northflank优化)`);

        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 3;

        this.heartbeatTimer = setInterval(async () => {
            if (!this.redisClient) {
                logger.debug(`[${this.getCurrentProvider()}] 💔 心跳跳过：Redis 客户端未初始化`);
                return;
            }

            const status = this.redisClient.status;

            // 新增：检测 end/close 状态并触发重启
            if (status === 'end' || status === 'close') {
                logger.warn(`[${this.getCurrentProvider()}] 💔 Redis ${status.toUpperCase()}: 触发重启`);
                this._restartRedisClient().catch(() => {});
                return;
            }

            if (status !== 'ready') {
                // 如果状态是 connecting，尝试触发连接
                if (status === 'connecting' || status === 'wait') {
                    logger.warn(`[${this.getCurrentProvider()}] 💔 心跳检测到 Redis 状态为 ${status}，尝试触发连接...`);
                    try {
                        // 发送 ping 即使不是 ready 状态，可能帮助 ioredis 完成连接
                        await this.redisClient.ping().catch(() => {});
                    } catch (e) {
                        // 忽略错误，让 ioredis 自己处理
                    }
                } else {
                    logger.debug(`[${this.getCurrentProvider()}] 💔 心跳跳过：Redis 状态为 ${status} (非 ready)`);
                }
                return;
            }

            try {
                const pingStart = Date.now();
                const pingResult = await this.redisClient.ping();
                const pingDuration = Date.now() - pingStart;

                // Northflank环境：更详细的延迟监控
                const isHighLatency = pingDuration > 200; // 200ms作为高延迟阈值

                logger.debug(`[${this.getCurrentProvider()}] 💓 Redis 心跳 PING`, {
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
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis 高延迟心跳`, {
                        durationMs: pingDuration,
                        threshold: '200ms',
                        environment: 'northflank'
                    });
                }

                // 如果PING失败，记录错误但不强制重连（依赖ioredis内置重连）
                if (pingResult !== 'PONG') {
                    logger.warn(`[${this.getCurrentProvider()}] ⚠️ Redis 心跳异常响应`, { result: pingResult });
                }
            } catch (error) {
                consecutiveFailures++;
                logger.warn(`[${this.getCurrentProvider()}] 🚨 Redis 心跳失败`, {
                    error: error.message,
                    code: error.code,
                    clientStatus: this.redisClient?.status,
                    consecutiveFailures,
                    maxAllowed: maxConsecutiveFailures
                });

                // Northflank环境：如果连续失败超过阈值，记录更详细的诊断信息
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    logger.error(`[${this.getCurrentProvider()}] 🚨 Redis 心跳连续失败超过阈值`, {
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
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            logger.info(`[${this.getCurrentProvider()}] 🛑 Redis 心跳机制已停止`);
        }
    }

    /**
     * 销毁实例，清理所有资源
     * 用于测试环境清理，防止异步泄漏
     */
    async destroy() {
        this.destroyed = true;
        logger.info(`[${this.getCurrentProvider()}] 🛑 正在销毁 CacheService 实例...`);
        
        if (typeof this.stopHeartbeat === 'function') {
            this.stopHeartbeat();
        }
        this.stopRecoveryCheck();

        if (this.redisClient) {
            try {
                // 使用带超时的 quit
                const quitPromise = this.redisClient.quit();
                const timeoutPromise = new Promise(resolve => setTimeout(resolve, 1000));
                await Promise.race([quitPromise, timeoutPromise]);
            } catch (e) {
                // 忽略错误
            }
            this.redisClient.removeAllListeners();
            this.redisClient = null;
        }

        this.redisInitPromise = null;
        this.isRedisInitializing = false;
        
        logger.info(`[${this.getCurrentProvider()}] ✅ CacheService 实例销毁完成`);
    }

    /**
     * 等待 Redis 客户端达到 ready 状态
     * @param {number} timeout - 超时时间（毫秒），默认 30000
     * @returns {Promise<boolean>} - 是否成功达到 ready 状态
     */
    async waitForReady(timeout = 30000) {
        // 如果没有 Redis 配置，直接返回 false
        if (!this.hasRedis) {
            logger.debug(`[${this.getCurrentProvider()}] ℹ️ waitForReady: 未配置 Redis，跳过等待`);
            return false;
        }

        // 如果已经 ready，立即返回
        if (this.redisClient && this.redisClient.status === 'ready') {
            return true;
        }

        // 如果客户端未初始化，等待一段时间让初始化完成
        if (!this.redisClient) {
            logger.debug(`[${this.getCurrentProvider()}] ℹ️ waitForReady: Redis 客户端未初始化，等待 2 秒...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // 如果仍然没有客户端，返回 false
        if (!this.redisClient) {
            logger.warn(`[${this.getCurrentProvider()}] ⚠️ waitForReady: Redis 客户端初始化失败`);
            return false;
        }

        // 如果已经 ready，返回 true
        if (this.redisClient.status === 'ready') {
            return true;
        }

        logger.info(`[${this.getCurrentProvider()}] 🔄 waitForReady: 等待 Redis 达到 ready 状态，当前状态: ${this.redisClient.status}`);

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                logger.warn(`[${this.getCurrentProvider()}] ⚠️ waitForReady: 等待超时 (${timeout}ms)，当前状态: ${this.redisClient.status}`);
                cleanup();
                resolve(false);
            }, timeout);

            const readyHandler = () => {
                logger.info(`[${this.getCurrentProvider()}] ✅ waitForReady: Redis 已达到 ready 状态`);
                cleanup();
                resolve(true);
            };

            const errorHandler = (error) => {
                logger.warn(`[${this.getCurrentProvider()}] ⚠️ waitForReady: Redis 错误: ${error.message}`);
                // 不立即拒绝，继续等待
            };

            const cleanup = () => {
                clearTimeout(timeoutId);
                if (this.redisClient) {
                    this.redisClient.removeListener('ready', readyHandler);
                    this.redisClient.removeListener('error', errorHandler);
                }
            };

            // 监听 ready 事件
            this.redisClient.on('ready', readyHandler);
            this.redisClient.on('error', errorHandler);

            // 也监听 connect 事件，因为 ready 会在 connect 之后触发
            this.redisClient.on('connect', () => {
                logger.debug(`[${this.getCurrentProvider()}] 🔄 waitForReady: Redis 已连接，等待 ready...`);
            });
        });
    }

}

export const cache = new CacheService();