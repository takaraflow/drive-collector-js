/**
 * RedisCache - Basic Redis cache provider using ioredis
 * Provides atomic operations: incr, lock, unlock
 */

import Redis from 'ioredis';
import { BaseCache } from './BaseCache.js';

class RedisCache extends BaseCache {
    /**
     * @param {Object} config - Redis configuration
     * @param {string} config.host - Redis host
     * @param {number} config.port - Redis port
     * @param {string} config.password - Redis password (optional)
     * @param {number} config.db - Redis database (optional, default 0)
     * @param {number} config.maxRetriesPerRequest - Max retries (default 1)
     */
    constructor(config) {
        super();
        this.config = {
            host: config.host,
            port: config.port,
            password: config.password,
            db: config.db || 0,
            maxRetriesPerRequest: config.maxRetriesPerRequest || 1,
            ...config
        };
        
        // Initialize ioredis instance
        this.redis = new Redis(this.config);
        
        // Error handling
        this.redis.on('error', (error) => {
            console.error('[RedisCache] Connection error:', error.message);
            // Propagate error to orchestrator if needed
            this._reportError(error);
        });
        
        this.redis.on('connect', () => {
            console.log('[RedisCache] Connected to Redis');
        });
    }

    /**
     * Report error to orchestrator (placeholder for actual reporting)
     * @param {Error} error 
     */
    _reportError(error) {
        // This will be handled by the orchestrator/error handler
        // For now, just log and rethrow for visibility
        if (error.code === 'ECONNREFUSED') {
            console.error('[RedisCache] ECONNREFUSED - Will trigger failover');
        }
    }

    /**
     * Initialize connection
     * @returns {Promise<void>}
     */
    async initialize() {
        try {
            // Test connection
            await this.redis.ping();
            await super.initialize();
            console.log('[RedisCache] Initialization successful');
        } catch (error) {
            console.error('[RedisCache] Initialization failed:', error.message);
            throw error;
        }
    }

    /**
     * Get a value from cache
     * @param {string} key - The cache key
     * @param {CacheValueType} type - The type of value to retrieve
     * @returns {Promise<any>} - The cached value or null if not found
     */
    async get(key, type = 'json') {
        try {
            const result = await this.redis.get(key);
            if (result === null) return null;

            switch (type) {
                case 'json':
                    return JSON.parse(result);
                case 'text':
                    return result;
                case 'buffer':
                    return Buffer.from(result);
                default:
                    return result;
            }
        } catch (error) {
            console.error('[RedisCache] Get error:', error.message);
            throw error;
        }
    }

    /**
     * Set a value in cache
     * @param {string} key - The cache key
     * @param {any} value - The value to cache
     * @param {number} ttl - Time to live in seconds
     * @returns {Promise<boolean>} - Success status
     */
    async set(key, value, ttl = 3600) {
        try {
            let serializedValue;
            
            if (typeof value === 'object') {
                serializedValue = JSON.stringify(value);
            } else {
                serializedValue = String(value);
            }

            const result = await this.redis.set(key, serializedValue, 'EX', ttl);
            return result === 'OK';
        } catch (error) {
            console.error('[RedisCache] Set error:', error.message);
            throw error;
        }
    }

    /**
     * Delete a value from cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - Success status
     */
    async delete(key) {
        try {
            const result = await this.redis.del(key);
            return result > 0;
        } catch (error) {
            console.error('[RedisCache] Delete error:', error.message);
            throw error;
        }
    }

    /**
     * Check if a key exists in cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - True if exists
     */
    async exists(key) {
        try {
            const result = await this.redis.exists(key);
            return result === 1;
        } catch (error) {
            console.error('[RedisCache] Exists error:', error.message);
            throw error;
        }
    }

    /**
     * Increment a numeric value
     * @param {string} key - The cache key
     * @returns {Promise<number>} - The new value
     */
    async incr(key) {
        try {
            const result = await this.redis.incr(key);
            return result;
        } catch (error) {
            console.error('[RedisCache] Incr error:', error.message);
            throw error;
        }
    }

    /**
     * Acquire a lock
     * @param {string} key - The lock key
     * @param {number} ttl - Lock TTL in seconds
     * @returns {Promise<boolean>} - True if lock acquired
     */
    async lock(key, ttl = 60) {
        try {
            // Convert seconds to milliseconds for PX
            const ttlMs = ttl * 1000;
            const result = await this.redis.set(key, 1, 'NX', 'PX', ttlMs);
            return result === 'OK';
        } catch (error) {
            console.error('[RedisCache] Lock error:', error.message);
            throw error;
        }
    }

    /**
     * Release a lock using Lua script for atomicity
     * @param {string} key - The lock key
     * @returns {Promise<boolean>} - True if lock released
     */
    async unlock(key) {
        try {
            // Lua script for atomic unlock - only delete if value is 1
            const luaScript = `
                if redis.call("get", KEYS[1]) == "1" then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            
            const result = await this.redis.eval(luaScript, 1, key);
            return result === 1;
        } catch (error) {
            console.error('[RedisCache] Unlock error:', error.message);
            throw error;
        }
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'RedisCache';
    }

    /**
     * Cleanup resources
     * @returns {Promise<void>}
     */
    async destroy() {
        try {
            await this.redis.quit();
            console.log('[RedisCache] Connection closed');
        } catch (error) {
            console.error('[RedisCache] Destroy error:', error.message);
        }
    }
}

export { RedisCache };