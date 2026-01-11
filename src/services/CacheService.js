/**
 * CacheService.js
 * 
 * Orchestrator and Factory for the Cache System.
 * 
 * Responsibilities:
 * 1. Factory: Detects environment variables and instantiates the correct Cache Provider.
 * 2. L1/L2 Caching: Uses LocalCache (L1) for high-speed access and Provider (L2) for persistence.
 * 3. Failover: Automatically switches to a fallback provider if the primary fails.
 * 4. Recovery: Monitors failed providers and attempts to reconnect.
 */

import { getConfig } from "../config/index.js";
import { localCache } from "../utils/LocalCache.js";
import { logger } from "./logger/index.js";
import { parseCacheConfig } from "../utils/configParser.js";

// --- Import Providers ---
// Concrete Providers
import { CloudflareKVCache } from './cache/CloudflareKVCache.js';
import { RedisCache } from './cache/RedisCache.js';
import { RedisTLSCache } from './cache/RedisTLSCache.js';
import { NorthFlankRTCache } from './cache/NorthFlankRTCache.js';
import { RedisHTTPCache } from './cache/RedisHTTPCache.js';
import { UpstashRHCache } from './cache/UpstashRHCache.js';
import { ValkeyCache } from './cache/ValkeyCache.js';
import { ValkeyTLSCache } from './cache/ValkeyTLSCache.js';
import { AivenVTCache } from './cache/AivenVTCache.js';

const log = logger.withModule ? logger.withModule('CacheService') : logger;

class CacheService {
    constructor(options = {}) {
        this.env = options.env || process.env;
        this.isInitialized = false;
        
        // Providers
        this.primaryProvider = null;
        this.fallbackProvider = null;
        this.providerList = []; // List of all configured providers
        
        // State
        this.currentProviderName = 'MemoryCache';
        this.isFailoverMode = false;
        this.recoveryTimer = null;
        this.failureCount = 0;
        this.maxFailuresBeforeFailover = 3;
        
        // L1 Cache Config
        this.l1Ttl = 10000; // 10 seconds default for L1
    }

    /**
     * Initialize the Cache Service
     * Loads configuration and sets up the primary provider.
     */
    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true; // Set early to prevent re-entry

        try {
            // 1. Load and parse providers from environment
            this.providerList = this._loadProvidersFromConfig();
            
            if (this.providerList.length === 0) {
                // Fallback to legacy detection if JSON config is missing
                log.warn('No CACHE_PROVIDERS found. Falling back to legacy detection.');
                const legacyProvider = this._createProviderFromLegacyEnv();
                if (legacyProvider) {
                    this.providerList.push({ instance: legacyProvider, config: { name: 'legacy' } });
                }
            }

            // 2. Sort by priority (ascending, 1 is highest)
            this.providerList.sort((a, b) => (a.config.priority || 99) - (b.config.priority || 99));

            // 3. Connect to the first available provider
            for (const providerEntry of this.providerList) {
                try {
                    // Try connect() first, then initialize() as fallback
                    if (typeof providerEntry.instance.connect === 'function') {
                        await providerEntry.instance.connect();
                    } else if (typeof providerEntry.instance.initialize === 'function') {
                        await providerEntry.instance.initialize();
                    }
                    this.primaryProvider = providerEntry.instance;
                    this.currentProviderName = providerEntry.instance.getProviderName();
                    this.isFailoverMode = false;
                    
                    log.info(`Connected to primary provider: ${this.currentProviderName} (${providerEntry.config.name})`);
                    break; // Stop on first successful connection
                } catch (error) {
                    log.error(`Failed to connect to ${providerEntry.config.name}: ${error.message}`);
                    // Continue to next provider
                }
            }

            if (!this.primaryProvider) {
                this.currentProviderName = 'MemoryCache';
                log.warn('No external cache provider connected. Using MemoryCache (L1 only).');
            }

            this.isInitialized = true;
        } catch (error) {
            log.error(`Initialization failed: ${error.message}`);
            this.isInitialized = true;
        }
    }

    /**
     * Loads providers from CACHE_PROVIDERS environment variable.
     * Parses JSON, interpolates env vars, and instantiates classes.
     */
    _loadProvidersFromConfig() {
        const providersJson = this.env.CACHE_PROVIDERS;
        if (!providersJson) return [];

        const configs = parseCacheConfig(providersJson);
        if (!Array.isArray(configs)) {
            log.error('CACHE_PROVIDERS must be a JSON array');
            return [];
        }

        const instances = [];

        for (const config of configs) {
            // Check for PRIMARY_CACHE_PROVIDER override
            if (this.env.PRIMARY_CACHE_PROVIDER && config.name !== this.env.PRIMARY_CACHE_PROVIDER) {
                log.info(`Skipping ${config.name} due to PRIMARY_CACHE_PROVIDER override`);
                continue;
            }

            try {
                const instance = this._instantiateProvider(config);
                if (instance) {
                    instances.push({ instance, config });
                }
            } catch (error) {
                log.error(`Failed to instantiate provider ${config.name}: ${error.message}`);
            }
        }

        return instances;
    }

    /**
     * Instantiates a specific provider class based on config.
     * Supports 'name' field for identification and 'replicas' for future expansion.
     */
    _instantiateProvider(config) {
        const { type, host, port, username, password, db, tls, restUrl, restToken, replicas, name } = config;

        // 1. Upstash / Redis HTTP
        if (type === 'upstash-rest' || (restUrl && restToken)) {
            log.info(`Instantiating UpstashRHCache for '${name}'`);
            return new UpstashRHCache({ url: restUrl, token: restToken, name });
        }

        // 2. Cloudflare KV
        if (type === 'cloudflare-kv' || (config.accountId && config.namespaceId)) {
            log.info(`Instantiating CloudflareKVCache for '${name}'`);
            return new CloudflareKVCache({
                accountId: config.accountId,
                namespaceId: config.namespaceId,
                token: config.token,
                name
            });
        }

        // 3. Redis / Valkey TCP/TLS
        if (host && port) {
            let authPart = '';
            if (username) {
                const safeUser = encodeURIComponent(username);
                const safePass = password ? encodeURIComponent(password) : '';
                authPart = `${safeUser}:${safePass}@`;
            } else if (password) {
                authPart = `:${encodeURIComponent(password)}@`;
            }
            const url = `redis://${authPart}${host}:${port}/${db || 0}`;
            
            // Determine if TLS is needed
            const isTls = tls?.enabled || (tls && tls.rejectUnauthorized !== undefined);
            
            // Determine if Valkey specific class is requested
            const isValkey = type === 'valkey' || (name && name.toLowerCase().includes('valkey'));

            // Log instantiation with name
            const providerName = isValkey ? 'Valkey' : 'Redis';
            const mode = isTls ? 'TLS' : 'TCP';
            log.info(`Instantiating ${providerName}${mode}Cache for '${name}'`);

            if (isTls) {
                const tlsOptions = {
                    rejectUnauthorized: tls.rejectUnauthorized !== false, // Default true
                    servername: tls.servername || host
                };
                
                if (isValkey) {
                    return new ValkeyTLSCache({ url, ...tlsOptions, name });
                }
                return new RedisTLSCache({ url, ...tlsOptions, name });
            } else {
                if (isValkey) {
                    return new ValkeyCache({ url, name });
                }
                return new RedisCache({ url, name });
            }
        }

        // 4. Northflank (Specialized Redis)
        if (type === 'northflank' || config.nfRedisUrl) {
            log.info(`Instantiating NorthFlankRTCache for '${name}'`);
            return new NorthFlankRTCache({ url: config.nfRedisUrl, name });
        }

        // 5. Aiven Valkey (Auto-detect)
        if (type === 'aiven-valkey' || (host && port && name && name.toLowerCase().includes('aiven'))) {
            log.info(`Instantiating AivenVTCache for '${name}'`);
            return new AivenVTCache({ url: `redis://${host}:${port}`, name });
        }

        log.warn(`Unknown provider config: ${JSON.stringify(config)}`);
        return null;
    }

    /**
     * Legacy Fallback: Creates a provider from old-style env vars.
     */
    _createProviderFromLegacyEnv() {
        const env = this.env;

        // Aiven
        const aivenConfig = AivenVTCache.detectConfig(env);
        if (aivenConfig) {
            try { return new AivenVTCache(aivenConfig); } catch (e) {}
        }
        // Valkey
        if (env.VALKEY_URL) {
            const useTls = env.VALKEY_TLS === 'true' || env.VALKEY_URL.startsWith('valkeys://');
            if (useTls) return new ValkeyTLSCache({ url: env.VALKEY_URL });
            return new ValkeyCache({ url: env.VALKEY_URL });
        }
        // Upstash
        const upstashConfig = UpstashRHCache.detectConfig(env);
        if (upstashConfig) {
            return new UpstashRHCache(upstashConfig);
        }
        // Northflank
        const northflankConfig = NorthFlankRTCache.detectConfig(env, { allowRedisUrl: false });
        if (northflankConfig) {
            return new NorthFlankRTCache(northflankConfig);
        }
        // Generic Redis
        if (env.REDIS_URL) {
            const isTls = env.REDIS_TLS === 'true' || env.REDIS_URL.startsWith('rediss://');
            const isHttp = env.REDIS_HTTP === 'true' || env.REDIS_URL.startsWith('http');
            if (isHttp) return new RedisHTTPCache({ url: env.REDIS_URL, token: env.REDIS_TOKEN });
            if (isTls) return new RedisTLSCache({ url: env.REDIS_URL });
            return new RedisCache({ url: env.REDIS_URL });
        }
        // Cloudflare KV
        const cfAccountId = env.CF_CACHE_ACCOUNT_ID || env.CF_KV_ACCOUNT_ID || env.CF_ACCOUNT_ID;
        const cfNamespaceId = env.CF_CACHE_NAMESPACE_ID || env.CF_KV_NAMESPACE_ID;
        const cfToken = env.CF_CACHE_TOKEN || env.CF_KV_TOKEN;
        if (cfAccountId && cfNamespaceId && cfToken) {
            return new CloudflareKVCache({ accountId: cfAccountId, namespaceId: cfNamespaceId, token: cfToken });
        }
        // Config file
        try {
            const config = getConfig();
            if (config.kv?.accountId && config.kv?.namespaceId && config.kv?.token) {
                return new CloudflareKVCache(config.kv);
            }
        } catch (e) {}

        return null;
    }

    /**
     * Core Get Method with L1/L2 and Failover
     */
    async get(key, type = "json", options = {}) {
        await this._ensureInitialized();

        // 1. L1 Cache Check (LocalCache)
        // Skip L1 if explicitly requested or if we are in a critical failover state (optional logic)
        if (!options.skipL1) {
            const l1Value = localCache.get(key);
            if (l1Value !== null && l1Value !== undefined) {
                // Refresh L1 TTL if needed (LocalCache handles this via set, but here we just return)
                return l1Value;
            }
        }

        // 2. L2 Cache Check (Provider)
        if (!this.primaryProvider && this.currentProviderName === 'MemoryCache') {
            return null; // No L2 available
        }

        try {
            const value = await this.primaryProvider.get(key, type);
            
            // If value found in L2, populate L1
            if (value !== null && value !== undefined) {
                const ttl = options.l1Ttl || this.l1Ttl;
                localCache.set(key, value, ttl);
            }
            
            return value;
        } catch (error) {
            log.error(`Get error on ${this.currentProviderName}: ${error.message}`);
            await this._handleProviderFailure(error);
            
            // Retry with failover if available
            if (this.isFailoverMode && this.fallbackProvider) {
                return this._getWithFallback(key, type, options);
            }
            
            return null;
        }
    }

    /**
     * Core Set Method with L1/L2
     */
    async set(key, value, ttl = 3600, options = {}) {
        await this._ensureInitialized();

        // 1. Update L1 (LocalCache)
        // Convert seconds to ms for LocalCache
        if (!options.skipL1) {
            localCache.set(key, value, ttl * 1000);
        }

        // 2. Update L2 (Provider)
        if (!this.primaryProvider && this.currentProviderName === 'MemoryCache') {
            return true; // Memory only
        }

        // If in failover mode, don't attempt L2 writes (degrade to L1 only)
        if (this.isFailoverMode) {
            log.warn('In failover mode, skipping L2 write');
            return true; // L1 write succeeded
        }

        try {
            const result = await this.primaryProvider.set(key, value, ttl);
            
            if (!result) throw new Error('Provider returned false');
            return true;
        } catch (error) {
            log.error(`Set error on ${this.currentProviderName}: ${error.message}`);
            await this._handleProviderFailure(error);
            
            // Failover write?
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

    /**
     * Core Delete Method
     */
    async delete(key) {
        await this._ensureInitialized();

        // 1. Delete from L1
        localCache.del(key);

        // 2. Delete from L2
        if (!this.primaryProvider) return true;

        try {
            await this.primaryProvider.delete(key);
            return true;
        } catch (error) {
            log.error(`Delete error: ${error.message}`);
            await this._handleProviderFailure(error);
            return false;
        }
    }

    /**
     * Handle Provider Failure
     * Increments failure count, triggers failover if threshold reached.
     */
    async _handleProviderFailure(error) {
        this.failureCount++;

        if (this.failureCount >= this.maxFailuresBeforeFailover && !this.isFailoverMode) {
            log.warn(`Max failures (${this.maxFailuresBeforeFailover}) reached. Triggering failover.`);
            await this._failover();
        }
    }

    /**
     * Execute Failover
     * Switches to Memory (L1) or attempts to find a secondary provider.
     */
    async _failover() {
        this.isFailoverMode = true;
        
        // Strategy: Memory Fallback
        // In a complex system, we might scan for a secondary Redis URL (e.g., REDIS_URL_BACKUP)
        // For now, we degrade gracefully to Memory-only mode (L1).
        
        log.warn('Failover active. Degrading to Memory (L1) mode. External writes disabled.');
        
        // Start recovery check
        this._startRecoveryCheck();
    }

    /**
     * Start Recovery Check
     * Periodically attempts to reconnect to the primary provider.
     */
    _startRecoveryCheck() {
        if (this.recoveryTimer) return;

        this.recoveryTimer = setInterval(async () => {
            if (!this.isFailoverMode) return;
            
            log.info('Attempting recovery of primary provider...');
            
            try {
                // Attempt a simple ping or get
                if (this.primaryProvider) {
                    // If it's a Redis-like provider, we can try ping
                    if (this.primaryProvider.client && this.primaryProvider.client.ping) {
                        await this.primaryProvider.client.ping();
                    } else {
                        // For HTTP providers, try a simple get
                        await this.primaryProvider.get('__recovery_check__');
                    }
                }

                // If we get here, it's alive
                log.info('Primary provider recovered!');
                this.isFailoverMode = false;
                this.failureCount = 0;
                clearInterval(this.recoveryTimer);
                this.recoveryTimer = null;
            } catch (e) {
                log.debug('Recovery attempt failed.');
            }
        }, 30000); // Check every 30 seconds
    }

    stopRecoveryCheck() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    }

    /**
     * Helper for L2 fallback reads
     */
    async _getWithFallback(key, type, options) {
        if (!this.fallbackProvider) return null;
        try {
            const val = await this.fallbackProvider.get(key, type);
            if (val !== null && val !== undefined) {
                localCache.set(key, val, options.l1Ttl || this.l1Ttl);
            }
            return val;
        } catch (e) {
            return null;
        }
    }

    /**
     * Ensure Initialization
     */
    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    /**
     * Get Current Provider Name
     */
    getCurrentProvider() {
        return this.currentProviderName;
    }

    /**
     * Get Connection Info
     */
    getConnectionInfo() {
        if (this.primaryProvider && typeof this.primaryProvider.getConnectionInfo === 'function') {
            return this.primaryProvider.getConnectionInfo();
        }
        return { provider: this.currentProviderName };
    }

    /**
     * List keys from the primary provider
     * @param {string} prefix - Optional prefix filter
     * @returns {Promise<string[]>} - Array of keys
     */
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
            log.error(`ListKeys error: ${error.message}`);
            return [];
        }
    }

    /**
     * Destroy / Cleanup
     */
    async destroy() {
        this.stopRecoveryCheck();
        if (this.primaryProvider && typeof this.primaryProvider.disconnect === 'function') {
            await this.primaryProvider.disconnect();
        }
        if (this.fallbackProvider && typeof this.fallbackProvider.disconnect === 'function') {
            await this.fallbackProvider.disconnect();
        }
    }
}

// Singleton Instance
const _instance = new CacheService();

// Proxy to ensure async methods (like initialize) are awaited if called on the instance directly
// However, since we use explicit initialization, we can just export the instance methods.
// To maintain compatibility with the old Proxy pattern:
export { CacheService };
export const cache = new Proxy(_instance, {
    get: (target, prop) => {
        const value = target[prop];
        if (typeof value === 'function') {
            return value.bind(target);
        }
        return value;
    }
});

export default cache;
