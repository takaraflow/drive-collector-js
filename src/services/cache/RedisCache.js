/**
 * RedisCache - Basic Redis cache provider using ioredis
 * Provides atomic operations: incr, lock, unlock
 */

import Redis from 'ioredis';
import { BaseCache } from './BaseCache.js';

class RedisCache extends BaseCache {
    /**
     * @param {Object} config - Redis configuration
     * @param {string} config.url - Redis connection URL
     * @param {string} config.host - Redis host
     * @param {number} config.port - Redis port
     * @param {string} config.password - Redis password (optional)
     * @param {number} config.db - Redis database (optional, default 0)
     * @param {number} config.maxRetriesPerRequest - Max retries (default 1)
     */
    constructor(config) {
        super(config);
        this.options = config;
        
        console.log('[RedisCache] Constructor called with:', config);
        
        // Initialize ioredis instance with URL parsing support
        if (config?.url) {
            const { url, ...redisOptions } = config;
            this.client = new Redis(url, redisOptions);
        } else {
            this.client = new Redis(config);
        }
        
        console.log('[RedisCache] Client created:', typeof this.client, this.client);
        
        // Error handling - only add event listeners if client supports them
        if (this.client.on) {
            this.client.on('error', (error) => {
                console.error('[RedisCache] Connection error:', error.message);
                // Propagate error to orchestrator if needed
                this._reportError(error);
            });
            
            this.client.on('connect', () => {
                console.log('[RedisCache] Connected to Redis');
            });
        }
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
     * Connect to Redis
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.connected) return;
        
        try {
            const status = this.client?.status;
            if (status === 'ready') {
                this.connected = true;
                console.log('[RedisCache] Connection successful');
                return;
            }

            // For testing with mocks, check if client has connect method
            if (this.client.connect && typeof this.client.connect === 'function') {
                if (status === 'connecting' || status === 'connect') {
                    // Avoid double-connect; wait for ready instead
                    await new Promise((resolve, reject) => {
                        this.client.once('ready', resolve);
                        this.client.once('error', reject);
                        // Timeout connection attempt
                        setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
                    });
                } else {
                    await this.client.connect();
                }
            } else {
                // For real connections, wait for ready event
                await new Promise((resolve, reject) => {
                    this.client.once('ready', resolve);
                    this.client.once('error', reject);
                    // Timeout connection attempt
                    setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
                });
            }
            
            this.connected = true;
            console.log('[RedisCache] Connection successful');
        } catch (error) {
            console.error('[RedisCache] Connection failed:', error.message);
            throw error;
        }
    }

    /**
     * Disconnect from Redis
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.connected) return;
        
        try {
            if (this.client.quit && typeof this.client.quit === 'function') {
                await this.client.quit();
            } else if (this.client.disconnect && typeof this.client.disconnect === 'function') {
                await this.client.disconnect();
            }
            this.connected = false;
            console.log('[RedisCache] Connection closed');
        } catch (error) {
            console.error('[RedisCache] Disconnect error:', error.message);
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
            const result = await this.client.get(key);
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
            if (type === 'json' && error instanceof SyntaxError) {
                return null;
            }
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

            const result = await this.client.set(key, serializedValue, 'EX', ttl);
            return result === 'OK';
        } catch (error) {
            // Handle circular reference errors
            if (error.message.includes('circular') || error.message.includes('Converting circular')) {
                return false;
            }
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
            const result = await this.client.del(key);
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
            const result = await this.client.exists(key);
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
            const result = await this.client.incr(key);
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
            const result = await this.client.set(key, 1, 'NX', 'PX', ttlMs);
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
            
            const result = await this.client.eval(luaScript, 1, key);
            return result === 1;
        } catch (error) {
            console.error('[RedisCache] Unlock error:', error.message);
            throw error;
        }
    }

    /**
     * List keys with optional prefix filter
     * Uses SCAN to avoid blocking Redis with KEYS
     * @param {string} prefix - Key prefix filter
     * @param {number} limit - Max keys to return
     * @returns {Promise<string[]>} - Array of keys
     */
    async listKeys(prefix = '', limit = 1000) {
        try {
            const pattern = prefix ? `${prefix}*` : '*';
            const keys = [];
            let cursor = '0';
            const count = 200;

            do {
                const result = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
                cursor = result[0];
                const batch = result[1] || [];
                if (batch.length > 0) {
                    keys.push(...batch);
                    if (limit && keys.length >= limit) {
                        return keys.slice(0, limit);
                    }
                }
            } while (cursor !== '0');

            return keys;
        } catch (error) {
            console.error('[RedisCache] ListKeys error:', error.message);
            throw error;
        }
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'Redis';
    }

    /**
     * Get connection information
     * @returns {Object} - Connection info
     */
    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            name: this.options.name,
            url: this.options.url || `redis://${this.options.host}:${this.options.port}`,
            status: this.connected ? 'ready' : 'disconnected'
        };
    }

    /**
     * Cleanup resources
     * @returns {Promise<void>}
     */
    async destroy() {
        await this.disconnect();
    }
}

export { RedisCache };
