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
import { RedisCache } from './cache/RedisCache.js';
import { RedisTLSCache } from './cache/RedisTLSCache.js';
import { NorthFlankRTCache } from './cache/NorthFlankRTCache.js';
import { RedisHTTPCache } from './cache/RedisHTTPCache.js';
import { UpstashRHCache } from './cache/UpstashRHCache.js';
import { ValkeyCache } from './cache/ValkeyCache.js';
import { ValkeyTLSCache } from './cache/ValkeyTLSCache.js';
import { AivenVTCache } from './cache/AivenVTCache.js';

const log = logger.withModule ? logger.withModule('CacheService') : logger;

/**
 * Atomic capability metadata for cache providers
 * Defines which providers support truly atomic operations
 */
const PROVIDER_ATOMIC_CAPABILITIES = {
    // ✅ Truly Atomic - Support native atomic operations
    'Redis': {
        atomic: true,
        lock: true,
        compareAndSet: true, // Native Lua script implementation
        notes: 'Supports atomic SET NX/PX, Lua scripts, and native CAS'
    },
    'RedisTLS': {
        atomic: true,
        lock: true,
        compareAndSet: true, // Inherited from RedisCache with Lua script CAS
        notes: 'Same as Redis, with TLS encryption and native CAS support'
    },
    'Valkey': {
        atomic: true,
        lock: true,
        compareAndSet: false,
        notes: 'Redis fork with same atomic guarantees'
    },
    'ValkeyTLS': {
        atomic: true,
        lock: true,
        compareAndSet: false,
        notes: 'Valkey with TLS encryption'
    },
    'AivenValkey': {
        atomic: true,
        lock: true,
        compareAndSet: false,
        notes: 'Managed Valkey with TLS, atomic operations preserved'
    },
    'UpstashRHCache': {
        atomic: true,
        lock: true,
        compareAndSet: true, // Has native compareAndSet implementation
        notes: 'HTTP Redis with atomic EVAL scripts and native CAS support'
    },
    'NorthFlankRTCache': {
        atomic: true,
        lock: true,
        compareAndSet: false,
        notes: 'Redis with TLS, atomic operations preserved'
    },
    
    // ❌ Memory Only - No distributed atomic guarantees
    'MemoryCache': {
        atomic: false,
        lock: false,
        compareAndSet: false,
        notes: 'Single-instance only, no distributed guarantees'
    }
};

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
        
        // Atomic Operation Warnings
        this.atomicWarningsShown = new Set(); // Track warnings to avoid duplicates
        
        // L1 Cache Config
        this.l1Ttl = 10000; // 10 seconds default for L1
        
        // L3 Cache Config (Persistent Layer)
        this.l3Cache = null;
        this.l3Enabled = process.env.CACHE_L3_ENABLED === 'true';
        
        // Cache Statistics
        this.stats = {
            hits: { l1: 0, l2: 0, l3: 0 },
            misses: 0,
            totalRequests: 0,
            lastReset: Date.now()
        };
        
        // Bloom Filter for cache penetration protection - opt-in via environment variable
        this.bloomFilter = null;
        this.bloomFilterEnabled = process.env.CACHE_BLOOM_FILTER === 'true';
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
                const legacyInstance = this._createProviderFromLegacyEnv();
                if (legacyInstance) {
                    this.providerList.push({
                        instance: legacyInstance,
                        config: { name: 'legacy-primary', priority: 1 }
                    });
                } else {
                    log.error('未发现有效的 CACHE_PROVIDERS 配置。缓存服务将仅运行在内存模式。');
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
                    
                    // Check and warn about atomic capabilities
                    this._checkAtomicCapabilities(this.currentProviderName);
                    
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

            // Initialize L3 and Bloom Filter
            await this._initializeL3Cache();
            await this._initializeBloomFilter();

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

        // 2. Redis / Valkey TCP/TLS
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
            try { return new AivenVTCache(aivenConfig); } catch (error) {
                log.warn('Failed to create AivenVTCache provider', {
                    error: error.message,
                    config: { ...aivenConfig, password: '***' }
                });
            }
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

        return null;
    }

    /**
     * Core Get Method with L1/L2/L3 and Failover
     */
    async get(key, type = "json", options = {}) {
        await this._ensureInitialized();

        // Update stats
        this.stats.totalRequests++;

        // 1. Bloom Filter Check (Penetration Protection)
        if (this.bloomFilterEnabled && this.bloomFilter) {
            if (!this.bloomFilter.mightContain(key)) {
                // Definitely not in cache, skip all checks
                this.stats.misses++;
                return null;
            }
        }

        // 2. L1 Cache Check (LocalCache)
        if (!options.skipL1) {
            const l1Value = localCache.get(key);
            if (l1Value !== null && l1Value !== undefined) {
                this.stats.hits.l1++;
                return l1Value;
            }
        }

        // 3. L2 Cache Check (Provider)
        if (!this.primaryProvider && this.currentProviderName === 'MemoryCache') {
            this.stats.misses++;
            return null;
        }

        try {
            const value = await this.primaryProvider.get(key, type);
            
            if (value !== null && value !== undefined) {
                // Populate L1
                const ttl = options.l1Ttl || this.l1Ttl;
                localCache.set(key, value, ttl);
                this.stats.hits.l2++;
                return value;
            }
            
            // 4. L3 Cache Check (Persistent Layer)
            if (this.l3Enabled && this.l3Cache) {
                const l3Value = await this.l3Cache.get(key, type);
                if (l3Value !== null && l3Value !== undefined) {
                    // Promote to L2 and L1
                    if (this.primaryProvider) {
                        await this.primaryProvider.set(key, l3Value, 3600);
                    }
                    localCache.set(key, l3Value, this.l1Ttl);
                    this.stats.hits.l3++;
                    return l3Value;
                }
            }

            this.stats.misses++;
            
            // Add to bloom filter if enabled
            if (this.bloomFilterEnabled && this.bloomFilter) {
                this.bloomFilter.add(key);
            }
            
            return null;
        } catch (error) {
            log.error(`Get error on ${this.currentProviderName}: ${error.message}`);
            
            try {
                await this._handleProviderFailure(error);
            } catch (failoverError) {
                log.error(`Failover failed: ${failoverError.message}`);
            }
            
            // Retry with failover if available
            if (this.isFailoverMode && this.fallbackProvider) {
                try {
                    return await this._getWithFallback(key, type, options);
                } catch (fallbackError) {
                    log.error(`Fallback get failed: ${fallbackError.message}`);
                }
            }
            
            this.stats.misses++;
            return null;
        }
    }

    /**
     * Core Set Method with L1/L2/L3
     */
    async set(key, value, ttl = 3600, options = {}) {
        await this._ensureInitialized();

        // TTL Randomization (±10%) to prevent cache stampede
        let actualTtl = ttl;
        if (!options.skipTtlRandomization) {
            const variance = ttl * 0.1; // 10% variance
            const randomOffset = (Math.random() - 0.5) * 2 * variance;
            actualTtl = Math.floor(ttl + randomOffset);
        }

        // 1. Update L1 (LocalCache)
        // Convert seconds to ms for LocalCache
        if (!options.skipL1) {
            localCache.set(key, value, actualTtl * 1000);
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
            const result = await this.primaryProvider.set(key, value, actualTtl);
            
            if (!result) throw new Error('Provider returned false');

            // 3. Update L3 (Persistent Layer) if enabled
            if (this.l3Enabled && this.l3Cache && !options.skipL3) {
                try {
                    // L3 gets longer TTL (2x)
                    await this.l3Cache.set(key, value, actualTtl * 2);
                } catch (l3Error) {
                    log.warn(`L3 cache write failed: ${l3Error.message}`);
                    // Don't fail the operation if L3 fails
                }
            }

            return true;
        } catch (error) {
            log.error(`Set error on ${this.currentProviderName}: ${error.message}`);
            await this._handleProviderFailure(error);
            
            // Failover write?
            if (this.isFailoverMode && this.fallbackProvider) {
                try {
                    await this.fallbackProvider.set(key, value, actualTtl);
                    return true;
                } catch (e) {
                    return false;
                }
            }
            
            return false;
        }
    }

    /**
     * Enhanced Delete Method with pattern support
     */
    async delete(key, options = {}) {
        await this._ensureInitialized();

        // Pattern-based deletion
        if (options.pattern) {
            return this._deleteByPattern(options.pattern);
        }

        // Single key deletion
        // 1. Delete from L1
        localCache.del(key);

        // 2. Delete from L2
        if (!this.primaryProvider) return true;

        try {
            await this.primaryProvider.delete(key);
            
            // 3. Delete from L3 if enabled
            if (this.l3Enabled && this.l3Cache) {
                try {
                    await this.l3Cache.delete(key);
                } catch (l3Error) {
                    log.warn(`L3 cache delete failed: ${l3Error.message}`);
                }
            }
            
            return true;
        } catch (error) {
            log.error(`Delete error: ${error.message}`);
            await this._handleProviderFailure(error);
            return false;
        }
    }

    /**
     * Compare and Set (CAS) - Atomic operation for distributed locks
     * @param {string} key - Cache key
     * @param {*} value - New value to set
     * @param {Object} options - Options including condition checks
     * @returns {Promise<boolean>} - Success status
     */
    async compareAndSet(key, value, options = {}) {
        await this._ensureInitialized();

        const {
            ifNotExists = false,  // Set only if key doesn't exist
            ifEquals = null,      // Set only if current value equals this
            metadata = {}         // Additional metadata for the operation
        } = options;

        // For distributed systems, we need to use provider's atomic operations
        if (!this.primaryProvider || this.currentProviderName === 'MemoryCache') {
            // Fallback to non-atomic operation for memory-only mode
            const current = await this.get(key, 'json');
            
            if (ifNotExists && current !== null) {
                return false;
            }
            
            if (ifEquals !== null && JSON.stringify(current) !== JSON.stringify(ifEquals)) {
                return false;
            }
            
            await this.set(key, value, 3600, { skipL1: false });
            return true;
        }

        try {
            // Check if provider supports atomic operations
            if (typeof this.primaryProvider.compareAndSet === 'function') {
                return await this.primaryProvider.compareAndSet(key, value, options);
            }

            // ⚠️ WARNING: Non-atomic fallback - potential race condition
            this._warnAboutAtomicity('compareAndSet');
            
            // Fallback: Use get-then-set with version checking
            const current = await this.primaryProvider.get(key, 'json');
            
            // Check conditions
            if (ifNotExists && current !== null) {
                return false;
            }
            
            if (ifEquals !== null) {
                const currentStr = JSON.stringify(current);
                const expectedStr = JSON.stringify(ifEquals);
                if (currentStr !== expectedStr) {
                    return false;
                }
            }

            // Perform the set
            const success = await this.primaryProvider.set(key, value, 3600);
            
            if (success) {
                // Update L1
                localCache.set(key, value, this.l1Ttl);
            }
            
            return success;
        } catch (error) {
            log.error(`CompareAndSet error: ${error.message}`);
            await this._handleProviderFailure(error);
            return false;
        }
    }

    /**
     * Check and warn about atomic capabilities of current provider
     * @private
     */
    _checkAtomicCapabilities(providerName) {
        const capabilities = PROVIDER_ATOMIC_CAPABILITIES[providerName];
        
        if (!capabilities) {
            log.warn(`⚠️  Unknown provider: ${providerName}. Atomic capabilities unknown.`);
            return;
        }

        if (!capabilities.atomic) {
            log.warn(`⚠️  ATOMICITY WARNING: ${providerName} does NOT support atomic operations!`);
            log.warn(`   ${capabilities.notes}`);
            log.warn(`   ⚠️  Distributed locks may not be safe in production!`);
        }

        if (capabilities.lock === false) {
            log.warn(`⚠️  LOCK WARNING: ${providerName} does NOT support safe locking!`);
            log.warn(`   ${capabilities.notes}`);
        }

        if (capabilities.compareAndSet === false && capabilities.atomic) {
            log.warn(`⚠️  CAS WARNING: ${providerName} supports atomic operations but NOT native compareAndSet.`);
            log.warn(`   Will use get-then-set fallback which has race condition risks.`);
        }
    }

    /**
     * Warn about atomicity issues for specific operations
     * @private
     */
    _warnAboutAtomicity(operation) {
        const providerName = this.currentProviderName;
        const warningKey = `${providerName}:${operation}`;
        
        if (this.atomicWarningsShown.has(warningKey)) {
            return; // Already warned
        }

        const capabilities = PROVIDER_ATOMIC_CAPABILITIES[providerName];
        
        if (capabilities && !capabilities.atomic) {
            log.warn(`⚠️  ATOMIC OPERATION WARNING: ${operation} called on ${providerName}`);
            log.warn(`   Provider: ${providerName}`);
            log.warn(`   Operation: ${operation}`);
            log.warn(`   Issue: ${capabilities.notes}`);
            log.warn(`   Risk: Race conditions possible in distributed environment`);
            log.warn(`   Recommendation: Use a truly atomic provider (Redis, Valkey, Upstash)`);
            
            this.atomicWarningsShown.add(warningKey);
        }
    }

    /**
     * Get atomic capability information for current provider
     * @returns {Object} - Atomic capability metadata
     */
    getAtomicCapabilities() {
        const capabilities = PROVIDER_ATOMIC_CAPABILITIES[this.currentProviderName];
        
        return {
            provider: this.currentProviderName,
            atomic: capabilities?.atomic || false,
            lock: capabilities?.lock || false,
            compareAndSet: capabilities?.compareAndSet || false,
            notes: capabilities?.notes || 'Unknown provider',
            safeForDistributedLocks: capabilities?.atomic === true && capabilities?.lock === true
        };
    }

    /**
     * Get all provider atomic capabilities
     * @returns {Object} - Map of provider names to their atomic capabilities
     */
    getAllProviderCapabilities() {
        return { ...PROVIDER_ATOMIC_CAPABILITIES };
    }

    /**
     * Validate if current provider is safe for distributed operations
     * @returns {Object} - Validation result with warnings
     */
    validateDistributedSafety() {
        const caps = this.getAtomicCapabilities();
        const warnings = [];
        
        if (!caps.atomic) {
            warnings.push('Provider does not support atomic operations');
        }
        
        if (!caps.lock) {
            warnings.push('Provider does not support safe distributed locking');
        }
        
        if (caps.compareAndSet === false && caps.atomic) {
            warnings.push('Provider uses non-atomic compareAndSet fallback');
        }

        return {
            safe: caps.safeForDistributedLocks,
            provider: this.currentProviderName,
            capabilities: caps,
            warnings: warnings,
            recommendation: caps.safeForDistributedLocks
                ? '✅ Safe for production distributed operations'
                : '⚠️  NOT recommended for critical distributed operations'
        };
    }

    /**
     * Delete by pattern (e.g., "user:*")
     */
    async _deleteByPattern(pattern) {
        if (!this.primaryProvider) return 0;

        try {
            // Get all keys from provider
            const keys = await this.listKeys();
            const matchingKeys = keys.filter(k => this._matchPattern(k, pattern));
            
            // Delete matching keys
            const deletePromises = matchingKeys.map(key => this.delete(key));
            await Promise.all(deletePromises);

            log.info(`Deleted ${matchingKeys.length} keys matching pattern: ${pattern}`);
            return matchingKeys.length;
        } catch (error) {
            log.error(`Pattern delete error: ${error.message}`);
            return 0;
        }
    }

    /**
     * Simple pattern matching (supports * and ? wildcards)
     */
    _matchPattern(key, pattern) {
        // Convert pattern to regex
        const regexPattern = pattern
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(key);
    }

    /**
     * Preheat cache with specific keys
     */
    async preheat(keys = []) {
        if (!Array.isArray(keys) || keys.length === 0) {
            log.warn('Preheat called with empty keys array');
            return { success: 0, failed: 0 };
        }

        log.info(`Starting cache preheat for ${keys.length} keys`);
        
        const results = {
            success: 0,
            failed: 0,
            totalTime: 0
        };

        const startTime = Date.now();

        // Process in batches to avoid overwhelming the system
        const batchSize = 3;
        for (let i = 0; i < keys.length; i += batchSize) {
            const batch = keys.slice(i, i + batchSize);
            const batchPromises = batch.map(keyConfig => this._preheatKey(keyConfig));
            const batchResults = await Promise.allSettled(batchPromises);
            
            batchResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    results.success++;
                } else {
                    results.failed++;
                }
            });
        }

        results.totalTime = Date.now() - startTime;
        log.info(`Preheat completed: ${results.success} succeeded, ${results.failed} failed in ${results.totalTime}ms`);

        return results;
    }

    /**
     * Preheat single key
     */
    async _preheatKey(keyConfig) {
        try {
            const key = typeof keyConfig === 'string' ? keyConfig : keyConfig.key;
            const loader = keyConfig.loader;
            const ttl = keyConfig.ttl || 3600;

            if (!key || !loader) {
                log.warn(`Invalid preheat config: ${JSON.stringify(keyConfig)}`);
                return false;
            }

            // Check if already cached
            const existing = await this.get(key, 'json', { skipL1: false });
            if (existing !== null) {
                log.debug(`Key ${key} already cached, skipping`);
                return true;
            }

            // Load data
            const data = await loader();
            if (data === null || data === undefined) {
                log.warn(`Preheat loader returned null for key: ${key}`);
                return false;
            }

            // Cache with extended TTL
            await this.set(key, data, ttl, { skipL3: false });
            log.debug(`Key ${key} preheated successfully`);
            return true;

        } catch (error) {
            log.error(`Preheat failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const total = this.stats.totalRequests;
        const hits = this.stats.hits.l1 + this.stats.hits.l2 + this.stats.hits.l3;
        const missRate = total > 0 ? (this.stats.misses / total * 100).toFixed(2) : 0;
        const hitRate = total > 0 ? (hits / total * 100).toFixed(2) : 0;

        return {
            totalRequests: total,
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate: `${hitRate}%`,
            missRate: `${missRate}%`,
            l1HitRate: total > 0 ? (this.stats.hits.l1 / total * 100).toFixed(2) : 0,
            l2HitRate: total > 0 ? (this.stats.hits.l2 / total * 100).toFixed(2) : 0,
            l3HitRate: total > 0 ? (this.stats.hits.l3 / total * 100).toFixed(2) : 0,
            lastReset: new Date(this.stats.lastReset).toISOString(),
            provider: this.currentProviderName,
            failoverMode: this.isFailoverMode
        };
    }

    /**
     * Reset cache statistics
     */
    resetStats() {
        this.stats = {
            hits: { l1: 0, l2: 0, l3: 0 },
            misses: 0,
            totalRequests: 0,
            lastReset: Date.now()
        };
        log.info('Cache statistics reset');
    }

    /**
     * Initialize L3 cache (persistent layer)
     */
    async _initializeL3Cache() {
        if (!this.l3Enabled) return;

        try {
            // Try to create a simple file-based cache for L3
            // This could be replaced with a proper persistent store
            const { FileCache } = await import('./cache/FileCache.js');
            this.l3Cache = new FileCache({
                basePath: './data/cache/l3',
                ttl: 3600 * 24 // 24 hours default
            });
            await this.l3Cache.connect();
            log.info('L3 cache initialized');
        } catch (error) {
            log.warn(`L3 cache initialization failed: ${error.message}`);
            this.l3Enabled = false;
        }
    }

    /**
     * Initialize Bloom Filter
     */
    async _initializeBloomFilter() {
        if (!this.bloomFilterEnabled) return;

        try {
            // Simple bloom filter implementation
            // In production, use a proper library like 'bloom-filters'
            const { BloomFilter } = await import('bloom-filters');
            // Use optimal parameters: 1000 expected items with 1% false positive rate
            this.bloomFilter = new BloomFilter(1000, 0.01);
            log.info('Bloom filter initialized');
        } catch (error) {
            log.warn(`Bloom filter initialization failed: ${error.message}`);
            this.bloomFilterEnabled = false;
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
     * Get Current Cache Provider Name with priority: config.name > class name
     */
    getCurrentCacheProvider() {
        // Try to find the current provider in the provider list to get config.name
        const currentProviderEntry = this.providerList.find(entry => 
            entry.instance.getProviderName() === this.currentProviderName
        );
        
        // Priority: config.name > class name
        // Check if config.name exists (including empty string), not just truthy
        if (currentProviderEntry && 'name' in currentProviderEntry.config && currentProviderEntry.config.name !== undefined) {
            return currentProviderEntry.config.name;
        }
        
        return this.currentProviderName;
    }

    /**
     * Get Connection Info
     */
    getConnectionInfo() {
        if (this.primaryProvider && typeof this.primaryProvider.getConnectionInfo === 'function') {
            return this.primaryProvider.getConnectionInfo();
        }
        return { provider: this.getCurrentCacheProvider() };
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

    /**
     * 增强的故障转移 - 支持多层回退策略
     * 1. 尝试切换到备用提供者
     * 2. 如果所有提供者都失败，降级到内存模式
     * 3. 支持自动恢复
     */
    async enhancedFailover() {
        log.info('Starting enhanced failover process...');
        
        // 1. 尝试切换到备用提供者
        if (this.providerList.length > 1) {
            const currentIndex = this.providerList.findIndex(p => p.instance === this.primaryProvider);
            const nextIndex = (currentIndex + 1) % this.providerList.length;
            const nextProvider = this.providerList[nextIndex];
            
            if (nextProvider && nextProvider.instance !== this.primaryProvider) {
                try {
                    log.info(`Attempting to switch to backup provider: ${nextProvider.config.name}`);
                    
                    // 尝试连接备用提供者
                    if (typeof nextProvider.instance.connect === 'function') {
                        await nextProvider.instance.connect();
                    } else if (typeof nextProvider.instance.initialize === 'function') {
                        await nextProvider.instance.initialize();
                    }
                    
                    // 切换提供者
                    this.fallbackProvider = this.primaryProvider;
                    this.primaryProvider = nextProvider.instance;
                    this.currentProviderName = nextProvider.instance.getProviderName();
                    this.isFailoverMode = false;
                    this.failureCount = 0;
                    
                    log.info(`✅ Successfully switched to backup provider: ${this.currentProviderName}`);
                    return true;
                } catch (error) {
                    log.error(`Failed to switch to backup provider ${nextProvider.config.name}:`, error.message);
                    // 继续到下一步
                }
            }
        }
        
        // 2. 如果所有外部提供者都失败，降级到内存模式
        log.warn('All external providers failed, degrading to Memory (L1) mode');
        this.isFailoverMode = true;
        this.currentProviderName = 'MemoryCache';
        
        // 3. 启动恢复监控
        this._startEnhancedRecoveryCheck();
        
        return false;
    }

    /**
     * 增强的恢复检查 - 支持多提供者轮询
     */
    _startEnhancedRecoveryCheck() {
        if (this.recoveryTimer) return;

        this.recoveryTimer = setInterval(async () => {
            if (!this.isFailoverMode && this.providerList.length <= 1) return;
            
            log.info('Enhanced recovery: Checking all providers...');
            
            // 按优先级顺序尝试所有提供者
            for (const providerEntry of this.providerList) {
                if (providerEntry.instance === this.primaryProvider) continue; // 跳过当前失败的
                
                try {
                    log.info(`Trying to recover: ${providerEntry.config.name}`);
                    
                    // 尝试简单的 ping 或 get 操作
                    if (typeof providerEntry.instance.get === 'function') {
                        await providerEntry.instance.get('__recovery_check__');
                    } else if (typeof providerEntry.instance.ping === 'function') {
                        await providerEntry.instance.ping();
                    } else if (typeof providerEntry.instance.connect === 'function') {
                        await providerEntry.instance.connect();
                    }
                    
                    // 如果成功，切换到这个提供者
                    log.info(`✅ Provider ${providerEntry.config.name} recovered!`);
                    this.fallbackProvider = this.primaryProvider;
                    this.primaryProvider = providerEntry.instance;
                    this.currentProviderName = providerEntry.instance.getProviderName();
                    this.isFailoverMode = false;
                    this.failureCount = 0;
                    
                    clearInterval(this.recoveryTimer);
                    this.recoveryTimer = null;
                    return;
                    
                } catch (e) {
                    log.debug(`Provider ${providerEntry.config.name} still unavailable: ${e.message}`);
                }
            }
            
            log.debug('Enhanced recovery: All providers still unavailable');
        }, 30000); // 每30秒检查一次
    }

    /**
     * 批量操作 - 支持故障转移的批量 get/set
     */
    async batchOperation(operations) {
        await this._ensureInitialized();
        
        const results = [];
        
        for (const op of operations) {
            try {
                if (op.type === 'get') {
                    const value = await this.get(op.key, op.type || 'json', op.options || {});
                    results.push({ success: true, key: op.key, value });
                } else if (op.type === 'set') {
                    const success = await this.set(op.key, op.value, op.ttl || 3600, op.options || {});
                    results.push({ success, key: op.key });
                } else if (op.type === 'delete') {
                    const success = await this.delete(op.key, op.options || {});
                    results.push({ success, key: op.key });
                }
            } catch (error) {
                log.error(`Batch operation failed for ${op.key}:`, error.message);
                results.push({ success: false, key: op.key, error: error.message });
            }
        }
        
        return results;
    }

    /**
     * 获取提供者健康状态
     */
    async getHealthStatus() {
        const status = {
            primary: this.currentProviderName,
            failoverMode: this.isFailoverMode,
            failureCount: this.failureCount,
            providers: [],
            overall: 'healthy'
        };

        // 检查所有提供者
        for (const providerEntry of this.providerList) {
            const providerStatus = {
                name: providerEntry.config.name,
                type: providerEntry.instance.getProviderName(),
                healthy: false
            };

            try {
                if (typeof providerEntry.instance.get === 'function') {
                    await providerEntry.instance.get('__health_check__');
                } else if (typeof providerEntry.instance.ping === 'function') {
                    await providerEntry.instance.ping();
                }
                providerStatus.healthy = true;
            } catch (e) {
                providerStatus.healthy = false;
                providerStatus.error = e.message;
            }

            status.providers.push(providerStatus);
        }

        // 确定整体状态
        if (this.isFailoverMode) {
            status.overall = 'degraded';
        } else if (status.providers.some(p => !p.healthy)) {
            status.overall = 'warning';
        }

        return status;
    }

    /**
     * 强制切换到指定提供者
     */
    async switchToProvider(name) {
        const targetProvider = this.providerList.find(p => p.config.name === name);
        
        if (!targetProvider) {
            throw new Error(`Provider ${name} not found`);
        }

        try {
            // 确保提供者已连接
            if (typeof targetProvider.instance.connect === 'function') {
                await targetProvider.instance.connect();
            }

            // 切换
            this.fallbackProvider = this.primaryProvider;
            this.primaryProvider = targetProvider.instance;
            this.currentProviderName = targetProvider.instance.getProviderName();
            this.isFailoverMode = false;
            this.failureCount = 0;

            log.info(`Manually switched to provider: ${name}`);
            return true;
        } catch (error) {
            log.error(`Failed to switch to provider ${name}:`, error.message);
            return false;
        }
    }

    /**
     * 获取所有提供者信息
     */
    getProviderList() {
        return this.providerList.map(p => ({
            name: p.config.name,
            type: p.instance.getProviderName(),
            priority: p.config.priority || 99
        }));
    }

    /**
     * 清除故障计数（手动恢复）
     */
    resetFailureCount() {
        this.failureCount = 0;
        this.isFailoverMode = false;
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }
        log.info('Failure count reset, failover mode disabled');
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

// Enhanced failover functions
export const enhancedFailover = () => _instance.enhancedFailover();
export const getHealthStatus = () => _instance.getHealthStatus();
export const switchToProvider = (name) => _instance.switchToProvider(name);
export const resetFailureCount = () => _instance.resetFailureCount();
export const batchOperation = (operations) => _instance.batchOperation(operations);
export const getProviderList = () => _instance.getProviderList();

export default cache;