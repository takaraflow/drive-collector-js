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
import { NFCacheClient } from './nf-cache-client.js';
import { RedisTLSCache } from './RedisTLSCache.js';
import { logger } from '../logger.js';

class CacheService {
    constructor(options = {}) {
        this.env = options.env || {};
        this.isInitialized = false;
        this.logger = options.logger;

        this.primaryProvider = null;
        this.primaryProviderEntry = null;
        this.fallbackProvider = null;
        this.fallbackProviderEntry = null;
        this.providerList = [];

        this.currentProviderName = 'MemoryCache';
        this.currentProviderConfigName = 'MemoryCache';
        this.isFailoverMode = false;
        this.recoveryTimer = null;
        this.failureCount = 0;
        this.maxFailuresBeforeFailover = options.maxFailuresBeforeFailover || 3;
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

    async initialize(ctx = null) {
        if (this.isInitialized) return;
        this.isInitialized = true;

        // CF Worker 生命周期管理：确保日志能被正确缓冲和发送
        const log = this._getLoggerWithBuffer(ctx);

        try {
            this.providerList = this._loadProvidersFromConfig(ctx);

            if (this.providerList.length === 0) {
                await log.warn('No CACHE_PROVIDERS found. Using MemoryCache (L1 only).', {}, ctx);
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

                    await log.info('Cache provider connected', this._createProviderLogContext(providerEntry), null, ctx);
                    break;
                } catch (error) {
                    await log.error(`Failed to connect to ${providerEntry.config.name}: ${error.message}`, {}, null, ctx);
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
            this.isInitialized = true;
        }
    }

    _loadProvidersFromConfig(ctx = null) {
        const log = this._getLoggerWithBuffer(ctx);
        const providersJson = this.env.CACHE_PROVIDERS;
        const hasCacheProviders = typeof providersJson === 'string'
            ? providersJson.trim().length > 0
            : !!providersJson;

        if (!hasCacheProviders) {
            const legacy = this._loadLegacyProvider(ctx);
            return legacy ? [legacy] : [];
        }

        const configs = parseCacheConfig(providersJson, this.env);
        if (!Array.isArray(configs)) {
            log.error('CACHE_PROVIDERS must be a JSON array');
            return [];
        }

        const instances = [];

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

    _loadLegacyProvider(ctx = null) {
        const log = this._getLoggerWithBuffer(ctx);
        const env = this.env || {};
        const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
        if (!redisUrl) return null;

        const legacyEnv = {
            ...env,
            NF_REDIS_URL: redisUrl,
            NF_REDIS_PASSWORD: env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD
        };

        try {
            const instance = new NFCacheClient(legacyEnv);
            const config = {
                name: 'LegacyRedis',
                type: 'redis',
                priority: 50
            };
            log.info('Loaded legacy cache provider', { provider: config.name, url: redisUrl });
            return { instance, config };
        } catch (error) {
            log.error('Failed to instantiate legacy cache provider', { error: error.message });
            return null;
        }
    }

    _instantiateProvider(ctx = null, config) {
        const log = this._getLoggerWithBuffer(ctx);
        const { type, name, host, port, username, password, db, tls, replicas } = config;

        if (replicas) {
            log.info(`Provider ${name} has replicas field defined (reserved for future use): ${JSON.stringify(replicas)}`);
        }

        if (type === 'cloudflare-kv' || (config.accountId && config.namespaceId && config.token)) {
            log.info(`Instantiating CloudflareKVCache for '${name}'`);
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

        this._startRecoveryCheck();
    }

    _startRecoveryCheck() {
        const log = this._getLogger();
        if (this.recoveryTimer) return;

        // CF Worker 兼容性检查：确保定时器 API 可用
        if (typeof setInterval === 'undefined') {
            log.warn('setInterval not available in this environment, skipping recovery check');
            return;
        }

        this.recoveryTimer = setInterval(async () => {
            if (!this.isFailoverMode) return;

            log.info('Attempting recovery of primary cache provider...');

            try {
                if (this.primaryProvider && this.primaryProvider.ping) {
                    await this.primaryProvider.ping();
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
                
                // CF Worker 兼容性：安全清理定时器
                if (this.recoveryTimer && typeof clearInterval !== 'undefined') {
                    clearInterval(this.recoveryTimer);
                    this.recoveryTimer = null;
                }
            } catch (e) {
                log.debug('Cache recovery attempt failed.');
            }
        }, 30000);
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
        if (!this.isInitialized) await this.initialize(ctx);
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
        this.stopRecoveryCheck();

        if (this.primaryProvider && typeof this.primaryProvider.destroy === 'function') {
            await this.primaryProvider.destroy();
        }
        if (this.fallbackProvider && typeof this.fallbackProvider.destroy === 'function') {
            await this.fallbackProvider.destroy();
        }
    }

    stopRecoveryCheck() {
        if (this.recoveryTimer && typeof clearInterval !== 'undefined') {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }
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
