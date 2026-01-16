/**
 * CacheService.js
 *
 * Orchestrator and Factory for the Cache System.
 *
 * Responsibilities:
 * 1. Factory: Parses CACHE_PROVIDERS config and instantiates correct Cache Providers.
 * 2. Provider Selection: Uses priority-based selection with PRIMARY_CACHE override.
 * 3. Failover: Automatically switches to fallback provider if primary fails.
 */

import { parseCacheConfig } from '../utils/configParser.js';
import { CloudflareKVCache } from './CloudflareKVCache.js';
import { RedisTLSCache } from './RedisTLSCache.js';
import { logger } from '../logger.js';

class CacheService {
    constructor(options = {}) {
        this.env = options.env || {};
        this.isInitialized = false;
        this.isInvalid = false; // P0修复：标记是否处于无效状态
        this.initPromise = null;
        this.logger = options.logger;

        this.primaryProvider = null;
        this.primaryProviderEntry = null;
        this.fallbackProvider = null;
        this.fallbackProviderEntry = null;
        this.providerList = [];

        this.currentProviderName = 'MemoryCache';
        this.currentProviderConfigName = 'MemoryCache';
        this.isFailoverMode = false;
        this.failureCount = 0;
        this.maxFailuresBeforeFailover = options.maxFailuresBeforeFailover || 3;
        this._lastRecoveryAttempt = 0;
    }

    _getLogger() {
        return this.logger || logger;
    }

    _getLoggerWithBuffer(ctx = null) {
        const baseLogger = this.logger || logger;
        // CF Worker 生命周期管理：如果有ctx.logBuffer，创建带缓冲的logger
        if (ctx?.logBuffer) {
            return baseLogger.child({ 
                module: 'CacheService',
                logBuffer: ctx.logBuffer 
            });
        }
        return baseLogger.child({ module: 'CacheService' });
    }

    async initialize(ctx = null, env = null) {
        // 如果传入了新的 env，更新它
        if (env) {
            this.env = env;
        }

        if (this.isInitialized) {
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            const log = this._getLoggerWithBuffer(ctx);
            try {
                this.providerList = this._loadProvidersFromConfig(ctx);

                if (this.providerList.length === 0) {
                    await log.warn('No CACHE_PROVIDERS found. Using MemoryCache (L1 only).', {}, ctx);
                    this.isInitialized = true;
                    return;
                }

                this.providerList.sort((a, b) => (a.config.priority || 99) - (b.config.priority || 99));

                for (const providerEntry of this.providerList) {
                    try {
                        await providerEntry.instance.connect();
                        this.primaryProviderEntry = providerEntry;
                        this.primaryProvider = providerEntry.instance;
                        this.currentProviderName = providerEntry.instance.getProviderName();
                        this.currentProviderConfigName = providerEntry.config.name;
                        this.isFailoverMode = false;
                        this.fallbackProvider = null;
                        this.fallbackProviderEntry = null;

                        await log.success('Cache provider connected', {
                            ...this._createProviderLogContext(providerEntry),
                            category: 'cache'
                        }, null, ctx);
                        break;
                    } catch (error) {
                        await log.error(`Failed to connect to cache provider ${providerEntry.config.name}`, {
                            error: error.message,
                            category: 'cache'
                        }, null, ctx);
                    }
                }

                if (!this.primaryProvider) {
                    this.primaryProviderEntry = null;
                    this.currentProviderName = 'MemoryCache';
                    this.currentProviderConfigName = 'MemoryCache';
                    this.isFailoverMode = false;
                    await log.warn('No external cache provider connected. Using MemoryCache (L1 only).', {}, ctx);
                }
                this.isInitialized = true;
            } catch (error) {
                await log.error(`CacheService initialization failed: ${error.message}`, {}, null, ctx);
                // 初始化失败不设置 isInitialized = true，允许重试
                this.initPromise = null;
                throw error;
            }
        })();

        return this.initPromise;
    }

    _loadProvidersFromConfig(ctx = null) {
        const log = this._getLoggerWithBuffer(ctx);
        const instances = [];
        
        // 1. 尝试解析 CACHE_PROVIDERS
        let configs = [];
        const providersJson = this.env.CACHE_PROVIDERS;
        if (providersJson && (typeof providersJson === 'string' ? providersJson.trim().length > 0 : true)) {
            configs = parseCacheConfig(providersJson, this.env);
            if (!Array.isArray(configs)) {
                log.error('CACHE_PROVIDERS must be a JSON array');
                configs = [];
            }
        }

        // 2. 自动检测 KV_STORAGE (向后兼容)
        // 如果没有配置任何 Provider，或者虽然配置了但没有覆盖 KV，且环境变量中有 KV_STORAGE，则自动添加
        const hasKvConfig = configs.some(c => c.type === 'cloudflare-kv-binding' || c.binding === 'KV_STORAGE');
        if (!hasKvConfig && this.env.KV_STORAGE) {
            log.info('Auto-detected KV_STORAGE binding', { category: 'cache' });
            configs.push({
                name: 'default-kv',
                type: 'cloudflare-kv-binding',
                binding: 'KV_STORAGE',
                priority: 100 // 低优先级作为默认回退
            });
        }

        // 3. 自动检测 Upstash (向后兼容)
        const hasUpstashConfig = configs.some(c => c.type === 'redis' && c.url && c.url.includes('upstash'));
        if (!hasUpstashConfig && this.env.UPSTASH_REDIS_REST_URL && this.env.UPSTASH_REDIS_REST_TOKEN) {
             // 只有当提供了完整的 URL (非 REST) 时才能作为 Redis 使用，
             // 但通常环境变量给的是 REST URL。这里 we 主要依赖 RedisTLSCache，它需要标准 Redis 协议。
             // 如果 env 中有 REDIS_URL，则添加
             if (this.env.REDIS_URL) {
                 log.info('Auto-detected REDIS_URL as cache provider', { category: 'cache' });
                 configs.push({
                     name: 'default-redis',
                     type: 'redis',
                     url: this.env.REDIS_URL,
                     priority: 50 // 高优先级
                 });
             }
        }

        if (configs.length === 0) {
            return [];
        }

        for (const config of configs) {
            if (!config || !config.name) {
                log.warn('Skipping provider config without name:', config);
                continue;
            }

            if (this.env.PRIMARY_CACHE && config.name !== this.env.PRIMARY_CACHE) {
                log.info(`Skipping ${config.name} due to PRIMARY_CACHE override (want: ${this.env.PRIMARY_CACHE})`);
                continue;
            }

            try {
                const instance = this._instantiateProvider(ctx, config);
                if (instance) {
                    instances.push({ instance, config });
                    log.info(`Loaded provider: ${config.name} (${config.type}, priority: ${config.priority || 'default'})`);
                }
            } catch (error) {
                log.error(`Failed to instantiate provider ${config.name}: ${error.message}`);
            }
        }

        return instances;
    }

    _instantiateProvider(ctx = null, config) {
        const log = this._getLoggerWithBuffer(ctx);
        const { type, name, host, port, username, password, db, tls, replicas } = config;

        if (replicas) {
            log.info(`Provider ${name} has replicas field defined (reserved for future use): ${JSON.stringify(replicas)}`);
        }

        // 支持原生 Cloudflare KV (直接使用 Worker 绑定)
        if (type === 'cloudflare-kv-binding') {
            const bindingName = config.binding || 'KV_STORAGE';
            const kv = this.env[bindingName];
            if (kv) {
                log.info(`Instantiating Native CloudflareKVCache for '${name}' using binding '${bindingName}'`);
                // 这里可以创建一个适配器类，或者直接在 CloudflareKVCache 中支持
                // 为了保持简单，我们暂时复用 CloudflareKVCache 的接口逻辑，但底层直接调用绑定
                return {
                    connect: () => Promise.resolve(),
                    get: (key, type) => kv.get(key, type === 'buffer' ? 'arrayBuffer' : type),
                    set: (key, value, ttl) => kv.put(key, value, { expirationTtl: ttl }),
                    delete: (key) => kv.delete(key),
                    listKeys: (prefix, limit) => kv.list({ prefix, limit }).then(res => res.keys.map(k => k.name)),
                    getProviderName: () => 'CloudflareKVNative',
                    destroy: () => Promise.resolve()
                };
            }
        }

        if (type === 'cloudflare-kv' || (config.accountId && config.namespaceId && config.token)) {
            log.info(`Instantiating CloudflareKVCache API for '${name}'`);
            return new CloudflareKVCache({
                accountId: config.accountId,
                namespaceId: config.namespaceId,
                token: config.token,
                name
            });
        }

        if (type === 'redis' || (host && port)) {
            let authPart = '';
            if (username) {
                const safeUser = encodeURIComponent(username);
                const safePass = password ? encodeURIComponent(password) : '';
                authPart = `${safeUser}:${safePass}@`;
            } else if (password) {
                authPart = `:${encodeURIComponent(password)}@`;
            }
            const url = `redis://${authPart}${host}:${port}/${db || 0}`;

            const isTls = tls?.enabled || (tls && tls.rejectUnauthorized !== undefined) || url.startsWith('rediss://');

            log.info(`Instantiating ${isTls ? 'RedisTLSCache' : 'RedisCache'} for '${name}'`);

            if (isTls) {
                return new RedisTLSCache({
                    url,
                    password,
                    rejectUnauthorized: tls?.rejectUnauthorized,
                    servername: tls?.servername || host,
                    ca: tls?.ca,
                    cert: tls?.cert,
                    key: tls?.key,
                    name
                });
            }
            return new RedisTLSCache({ url, password, name });
        }

        log.warn(`Unknown provider config for ${name}: ${JSON.stringify(config)}`);
        return null;
    }

    async get(key, type = 'json', options = {}, ctx = null) {
        await this._ensureInitialized(ctx);
        const log = this._getLoggerWithBuffer(ctx);

        if (!this.primaryProvider) {
            return null;
        }

        try {
            const value = await this.primaryProvider.get(key, type);
            return value;
        } catch (error) {
            await log.error(`Cache get error on ${this.currentProviderName}: ${error.message}`, {}, null, ctx);
            await this._handleProviderFailure(error, ctx);

            if (this.isFailoverMode && this.fallbackProvider) {
                return this._getWithFallback(key, type, options);
            }

            return null;
        }
    }

    async set(key, value, ttl = 3600, options = {}, ctx = null) {
        await this._ensureInitialized(ctx);
        const log = this._getLoggerWithBuffer(ctx);

        if (!this.primaryProvider) {
            return true;
        }

        if (this.isFailoverMode) {
            await log.warn('In failover mode, skipping L2 write', {}, null, ctx);
            return true;
        }

        try {
            await this.primaryProvider.set(key, value, ttl);
            return true;
        } catch (error) {
            await log.error(`Cache set error on ${this.currentProviderName}: ${error.message}`, {}, null, ctx);
            await this._handleProviderFailure(error, ctx);

            if (this.isFailoverMode && this.fallbackProvider) {
                try {
                    await this.fallbackProvider.set(key, value, ttl);
                    return true;
                } catch (e) {
                    return false;
                }
            }

            return false;
        }
    }

    async delete(key, ctx = null) {
        await this._ensureInitialized(ctx);
        const log = this._getLoggerWithBuffer(ctx);

        if (!this.primaryProvider) return true;

        try {
            await this.primaryProvider.delete(key);
            return true;
        } catch (error) {
            await log.error(`Cache delete error: ${error.message}`, {}, null, ctx);
            await this._handleProviderFailure(error, ctx);
            return false;
        }
    }

    async _handleProviderFailure(error, ctx = null) {
        this.failureCount++;
        const log = this._getLoggerWithBuffer(ctx);

        if (this.failureCount >= this.maxFailuresBeforeFailover && !this.isFailoverMode) {
            await log.warn(`Max failures (${this.maxFailuresBeforeFailover}) reached. Triggering failover.`, {}, null, ctx);
            await this._failover(ctx);
        }
    }

    async _failover(ctx = null) {
        const log = this._getLoggerWithBuffer(ctx);
        this.isFailoverMode = true;
        log.warn('Cache failover active. External writes disabled.', this._createProviderLogContext(this.primaryProviderEntry));

        for (const entry of this.providerList) {
            if (entry.instance !== this.primaryProvider) {
                try {
                    await entry.instance.connect();
                    this.fallbackProvider = entry.instance;
                    this.fallbackProviderEntry = entry;
                    this.currentProviderName = entry.instance.getProviderName();
                    this.currentProviderConfigName = entry.config.name;
                    log.info('Switched to fallback cache provider', this._createProviderLogContext(entry));
                    break;
                } catch (e) {
                    log.error(`Failed to connect to backup provider ${entry.config.name}: ${e.message}`);
                }
            }
        }
    }

    async _checkRecovery(ctx = null) {
        if (!this.isFailoverMode || !this.primaryProvider) return;

        const log = this._getLoggerWithBuffer(ctx);
        
        // 限制恢复检查频率，避免每个请求都尝试连接
        const now = Date.now();
        if (this._lastRecoveryAttempt && now - this._lastRecoveryAttempt < 30000) {
            return;
        }
        this._lastRecoveryAttempt = now;

        const attemptRecovery = async () => {
            try {
                log.info('Attempting recovery of primary cache provider...');
                if (this.primaryProvider.ping) {
                    await this.primaryProvider.ping();
                } else {
                    await this.primaryProvider.get('healthcheck_ping');
                }

                if (this.primaryProviderEntry) {
                    this.currentProviderName = this.primaryProviderEntry.instance.getProviderName();
                    this.currentProviderConfigName = this.primaryProviderEntry.config.name;
                }
                log.info('Primary cache provider recovered', this._createProviderLogContext(this.primaryProviderEntry));
                this.isFailoverMode = false;
                this.failureCount = 0;
                this.fallbackProvider = null;
                this.fallbackProviderEntry = null;
            } catch (e) {
                log.debug('Cache recovery attempt failed.', { error: e.message });
            }
        };

        // 在 CF Worker 中，使用 ctx.waitUntil 异步执行恢复检查，不阻塞当前请求
        if (ctx && ctx.waitUntil) {
            ctx.waitUntil(attemptRecovery());
        } else {
            await attemptRecovery();
        }
    }

    async _getWithFallback(key, type, options) {
        if (!this.fallbackProvider) return null;
        try {
            return await this.fallbackProvider.get(key, type);
        } catch (e) {
            return null;
        }
    }

    async _ensureInitialized(ctx = null) {
        if (!this.isInitialized) {
            await this.initialize(ctx);
        } else if (this.isFailoverMode) {
            // 如果处于故障模式，尝试恢复
            await this._checkRecovery(ctx);
        }
    }

    getCurrentProvider() {
        return this.currentProviderName;
    }

    getConnectionInfo() {
        const activeEntry = this._getActiveProviderEntry();
        const activeInstance = activeEntry?.instance;

        if (activeInstance && typeof activeInstance.getConnectionInfo === 'function') {
            const info = activeInstance.getConnectionInfo();
            return {
                ...info,
                provider: info.provider || this.currentProviderName,
                providerConfig: activeEntry?.config?.name || this.currentProviderConfigName,
                failover: this.isFailoverMode
            };
        }

        return {
            provider: this.currentProviderName,
            providerConfig: this.currentProviderConfigName,
            failover: this.isFailoverMode
        };
    }

    _getActiveProviderEntry() {
        if (this.isFailoverMode && this.fallbackProviderEntry) {
            return this.fallbackProviderEntry;
        }
        return this.primaryProviderEntry;
    }

    _createProviderLogContext(entry) {
        const config = entry?.config || {};
        return {
            provider: entry?.instance?.getProviderName?.() || this.currentProviderName,
            providerConfig: config.name || this.currentProviderConfigName,
            priority: config.priority ?? 'default',
            failover: this.isFailoverMode
        };
    }

    async listKeys(prefix = '', ctx = null) {
        await this._ensureInitialized(ctx);
        const log = this._getLoggerWithBuffer(ctx);

        if (!this.primaryProvider) {
            return [];
        }

        try {
            if (typeof this.primaryProvider.listKeys === 'function') {
                return await this.primaryProvider.listKeys(prefix, 1000, ctx);
            }
            return [];
        } catch (error) {
            await log.error(`Cache listKeys error: ${error.message}`, {}, null, ctx);
            return [];
        }
    }

    async destroy() {
        if (this.primaryProvider && typeof this.primaryProvider.destroy === 'function') {
            await this.primaryProvider.destroy();
        }
        if (this.fallbackProvider && typeof this.fallbackProvider.destroy === 'function') {
            await this.fallbackProvider.destroy();
        }
        this.isInitialized = false;
        this.initPromise = null;
    }
}

const _instance = new CacheService();

export { CacheService };
export const cacheService = new Proxy(_instance, {
    get: (target, prop) => {
        const value = target[prop];
        if (typeof value === 'function') {
            return value.bind(target);
        }
        return value;
    }
});

export default cacheService;
