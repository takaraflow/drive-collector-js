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

const log = logger.withModule ? logger.withModule('CacheService') : logger;

class CacheService {
    constructor(options = {}) {
        this.env = options.env || {};
        this.isInitialized = false;

        this.primaryProvider = null;
        this.fallbackProvider = null;
        this.providerList = [];

        this.currentProviderName = 'MemoryCache';
        this.isFailoverMode = false;
        this.recoveryTimer = null;
        this.failureCount = 0;
        this.maxFailuresBeforeFailover = options.maxFailuresBeforeFailover || 3;
    }

    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        try {
            this.providerList = this._loadProvidersFromConfig();

            if (this.providerList.length === 0) {
                log.warn('No CACHE_PROVIDERS found. Using MemoryCache (L1 only).');
                return;
            }

            this.providerList.sort((a, b) => (a.config.priority || 99) - (b.config.priority || 99));

            for (const providerEntry of this.providerList) {
                try {
                    await providerEntry.instance.connect();
                    this.primaryProvider = providerEntry.instance;
                    this.currentProviderName = providerEntry.instance.getProviderName();
                    this.isFailoverMode = false;

                    log.info(`Connected to primary provider: ${this.currentProviderName} (${providerEntry.config.name})`);
                    break;
                } catch (error) {
                    log.error(`Failed to connect to ${providerEntry.config.name}: ${error.message}`);
                }
            }

            if (!this.primaryProvider) {
                this.currentProviderName = 'MemoryCache';
                log.warn('No external cache provider connected. Using MemoryCache (L1 only).');
            }

            this.isInitialized = true;
        } catch (error) {
            log.error(`CacheService initialization failed: ${error.message}`);
            this.isInitialized = true;
        }
    }

    _loadProvidersFromConfig() {
        const providersJson = this.env.CACHE_PROVIDERS;
        if (!providersJson) return [];

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
                const instance = this._instantiateProvider(config);
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

    _instantiateProvider(config) {
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

    async get(key, type = 'json', options = {}) {
        await this._ensureInitialized();

        if (!this.primaryProvider) {
            return null;
        }

        try {
            const value = await this.primaryProvider.get(key, type);
            return value;
        } catch (error) {
            log.error(`Cache get error on ${this.currentProviderName}: ${error.message}`);
            await this._handleProviderFailure(error);

            if (this.isFailoverMode && this.fallbackProvider) {
                return this._getWithFallback(key, type, options);
            }

            return null;
        }
    }

    async set(key, value, ttl = 3600, options = {}) {
        await this._ensureInitialized();

        if (!this.primaryProvider) {
            return true;
        }

        if (this.isFailoverMode) {
            log.warn('In failover mode, skipping L2 write');
            return true;
        }

        try {
            await this.primaryProvider.set(key, value, ttl);
            return true;
        } catch (error) {
            log.error(`Cache set error on ${this.currentProviderName}: ${error.message}`);
            await this._handleProviderFailure(error);

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

    async delete(key) {
        await this._ensureInitialized();

        if (!this.primaryProvider) return true;

        try {
            await this.primaryProvider.delete(key);
            return true;
        } catch (error) {
            log.error(`Cache delete error: ${error.message}`);
            await this._handleProviderFailure(error);
            return false;
        }
    }

    async _handleProviderFailure(error) {
        this.failureCount++;

        if (this.failureCount >= this.maxFailuresBeforeFailover && !this.isFailoverMode) {
            log.warn(`Max failures (${this.maxFailuresBeforeFailover}) reached. Triggering failover.`);
            await this._failover();
        }
    }

    async _failover() {
        this.isFailoverMode = true;
        log.warn('Cache failover active. External writes disabled.');

        for (const entry of this.providerList) {
            if (entry.instance !== this.primaryProvider) {
                try {
                    await entry.instance.connect();
                    this.fallbackProvider = entry.instance;
                    log.info(`Failover to backup provider: ${entry.instance.getProviderName()}`);
                    break;
                } catch (e) {
                    log.error(`Failed to connect to backup provider ${entry.config.name}: ${e.message}`);
                }
            }
        }

        this._startRecoveryCheck();
    }

    _startRecoveryCheck() {
        if (this.recoveryTimer) return;

        this.recoveryTimer = setInterval(async () => {
            if (!this.isFailoverMode) return;

            log.info('Attempting recovery of primary cache provider...');

            try {
                if (this.primaryProvider && this.primaryProvider.ping) {
                    await this.primaryProvider.ping();
                }

                log.info('Primary cache provider recovered!');
                this.isFailoverMode = false;
                this.failureCount = 0;
                this.fallbackProvider = null;
                clearInterval(this.recoveryTimer);
                this.recoveryTimer = null;
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

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    getCurrentProvider() {
        return this.currentProviderName;
    }

    getConnectionInfo() {
        if (this.primaryProvider && typeof this.primaryProvider.getConnectionInfo === 'function') {
            return this.primaryProvider.getConnectionInfo();
        }
        return { provider: this.currentProviderName };
    }

    async listKeys(prefix = '') {
        await this._ensureInitialized();

        if (!this.primaryProvider) {
            return [];
        }

        try {
            if (typeof this.primaryProvider.listKeys === 'function') {
                return await this.primaryProvider.listKeys(prefix);
            }
            return [];
        } catch (error) {
            log.error(`Cache listKeys error: ${error.message}`);
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
        if (this.recoveryTimer) {
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
