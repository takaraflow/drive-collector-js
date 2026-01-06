/**
 * RedisHTTPCache - Generic Redis over HTTP provider
 * Provides Redis operations via HTTP REST API
 * Base class for HTTP-based Redis implementations
 */

import { BaseCache } from './BaseCache.js';

class RedisHTTPCache extends BaseCache {
    /**
     * @param {Object} config - HTTP Redis configuration
     * @param {string} config.url - Redis HTTP endpoint URL
     * @param {string} config.token - Authentication token
     */
    constructor(config) {
        super();
        
        this.url = config.url;
        this.token = config.token;
        
        if (!this.url || !this.token) {
            throw new Error('RedisHTTPCache requires url and token');
        }
        
        this.apiUrl = this.url.replace(/\/$/, ''); // Remove trailing slash
        this.REQUEST_TIMEOUT = 5000;
        console.log('[RedisHTTPCache] Initialized with HTTP endpoint');
    }

    /**
     * Send Redis command via HTTP
     * @private
     * @param {Array|Array[]} command - Redis command array or array of commands for pipeline
     * @returns {Promise<any>} - Command result
     */
    async _sendCommand(command) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);
        
        // Check if this is a pipeline (array of arrays)
        const isPipeline = Array.isArray(command) && command.length > 0 && Array.isArray(command[0]);
        
        try {
            const response = await fetch(`${this.apiUrl}/exec`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(command),
                signal: controller.signal
            });
            
            clearTimeout(id);
            
            if (!response.ok) {
                // Handle specific HTTP errors
                if (response.status === 401) {
                    throw new Error('Authentication failed - check your token');
                }
                if (response.status === 429) {
                    throw new Error('Rate limit exceeded');
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // Handle error response
            if (data.error) {
                throw new Error(data.error);
            }
            
            // Handle pipeline response (array of results)
            if (isPipeline) {
                // Pipeline returns array of {result: ...} or {error: ...}
                if (Array.isArray(data)) {
                    return data.map(item => {
                        if (item.error) {
                            return new Error(item.error);
                        }
                        return item.result;
                    });
                }
                return data;
            }
            
            // Handle single command response
            if ('result' in data) {
                return data.result;
            }
            
            // Handle edge cases
            if (data === null || data === undefined) {
                return null;
            }
            
            return data;
        } catch (error) {
            clearTimeout(id);
            
            // Network errors
            if (error.name === 'AbortError') {
                console.error('[RedisHTTPCache] Request timeout');
                throw new Error('Request timeout');
            }
            
            if (error.message.includes('fetch')) {
                console.error('[RedisHTTPCache] Network error:', error.message);
                throw new Error('Network error connecting to Redis');
            }
            
            console.error('[RedisHTTPCache] Command error:', error.message);
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
            const result = await this._sendCommand(['GET', key]);
            
            if (result === null || result === undefined) return null;
            
            switch (type) {
                case 'json':
                    try {
                        return JSON.parse(result);
                    } catch {
                        return result;
                    }
                case 'text':
                    return result;
                case 'buffer':
                    return Buffer.from(result);
                default:
                    return result;
            }
        } catch (error) {
            return null;
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
            const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
            const result = await this._sendCommand(['SET', key, serializedValue, 'EX', ttl]);
            return result === 'OK';
        } catch (error) {
            return false;
        }
    }

    /**
     * Delete a value from cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - Success status
     */
    async delete(key) {
        try {
            const result = await this._sendCommand(['DEL', key]);
            return result > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if a key exists in cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - True if exists
     */
    async exists(key) {
        try {
            const result = await this._sendCommand(['EXISTS', key]);
            return result === 1;
        } catch (error) {
            return false;
        }
    }

    /**
     * Increment a numeric value
     * @param {string} key - The cache key
     * @returns {Promise<number>} - The new value
     */
    async incr(key) {
        try {
            const result = await this._sendCommand(['INCR', key]);
            return result;
        } catch (error) {
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
            const result = await this._sendCommand(['SET', key, '1', 'NX', 'EX', ttl]);
            return result === 'OK';
        } catch (error) {
            return false;
        }
    }

    /**
     * Release a lock using Lua script for atomicity
     * @param {string} key - The lock key
     * @returns {Promise<boolean>} - True if lock released
     */
    async unlock(key) {
        try {
            const luaScript = `
                if redis.call("get", KEYS[1]) == "1" then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            const result = await this._sendCommand(['EVAL', luaScript, '1', key]);
            return result === 1;
        } catch (error) {
            return false;
        }
    }

    /**
     * List keys with optional prefix filter
     * @param {string} prefix - Key prefix filter
     * @returns {Promise<string[]>} - Array of keys
     */
    async listKeys(prefix = '') {
        try {
            const pattern = prefix ? `${prefix}*` : '*';
            const result = await this._sendCommand(['KEYS', pattern]);
            return result || [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Create a pipeline for batch operations
     * @returns {Pipeline} - Pipeline instance
     */
    pipeline() {
        return new Pipeline(this);
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'RedisHTTPCache';
    }

    /**
     * Get connection info for debugging
     * @returns {Object} - Connection details
     */
    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            url: this._maskUrl(this.url),
            hasToken: !!this.token
        };
    }

    /**
     * Mask URL for logging
     * @param {string} url
     * @returns {string} - Masked URL
     */
    _maskUrl(url) {
        if (!url) return 'undefined';
        return url.replace(/\/\/[^@]+@/, '//***@');
    }

    /**
     * Cleanup resources
     * @returns {Promise<void>}
     */
    async destroy() {
        console.log('[RedisHTTPCache] Connection closed');
    }
}

/**
 * Pipeline class for batch operations
 */
class Pipeline {
    constructor(cache) {
        this.cache = cache;
        this.commands = [];
    }

    /**
     * Add SET command to pipeline
     */
    set(key, value, ttl) {
        const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
        if (ttl) {
            this.commands.push(['SET', key, serializedValue, 'EX', ttl]);
        } else {
            this.commands.push(['SET', key, serializedValue]);
        }
        return this;
    }

    /**
     * Add GET command to pipeline
     */
    get(key) {
        this.commands.push(['GET', key]);
        return this;
    }

    /**
     * Add DEL command to pipeline
     */
    del(key) {
        this.commands.push(['DEL', key]);
        return this;
    }

    /**
     * Add EXISTS command to pipeline
     */
    exists(key) {
        this.commands.push(['EXISTS', key]);
        return this;
    }

    /**
     * Add INCR command to pipeline
     */
    incr(key) {
        this.commands.push(['INCR', key]);
        return this;
    }

    /**
     * Add EXPIRE command to pipeline
     */
    expire(key, seconds) {
        this.commands.push(['EXPIRE', key, seconds]);
        return this;
    }

    /**
     * Execute all commands in pipeline
     * @returns {Promise<Array>} - Array of results
     */
    async exec() {
        if (this.commands.length === 0) {
            return [];
        }

        try {
            // Use _sendCommand with pipeline array
            const result = await this.cache._sendCommand(this.commands);
            return result || [];
        } catch (error) {
            console.error('[Pipeline] Execution error:', error.message);
            throw error;
        }
    }
}

export { RedisHTTPCache, Pipeline };