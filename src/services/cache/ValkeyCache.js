/**
 * ValkeyCache.js
 * 
 * Implementation of BaseCache using Valkey (Redis fork).
 * This class mirrors RedisCache but targets Valkey specific configurations.
 * 
 * Dependencies: ioredis
 */

import { BaseCache } from './BaseCache.js';
import Redis from 'ioredis';

class ValkeyCache extends BaseCache {
    /**
     * @param {Object} options - Configuration options
     * @param {string} options.url - Valkey connection URL (valkey://...)
     * @param {number} [options.db] - Database index
     * @param {number} [options.retryDelay] - Delay between retries in ms
     * @param {number} [options.maxRetriesPerRequest] - Max retries
     */
    constructor(options = {}) {
        super(options);
        this.client = null;
        this.isReady = false;
        
        // Store the options for later use
        this.options = options;
        
        // Create Redis client instance immediately (but don't connect yet)
        if (options.url) {
            const redisOptions = {
                db: options.db || 0,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: options.maxRetriesPerRequest || 3,
                enableReadyCheck: true,
                lazyConnect: true  // Don't connect automatically
            };
            
            // Add TLS options if provided
            if (options.tls) {
                redisOptions.tls = options.tls;
            }
            
            this.client = new Redis(options.url, redisOptions);
        }
    }

    async connect() {
        if (this.connected) return this;

        // Create client if it doesn't exist (for cases where connect is called without constructor)
        if (!this.client && this.options.url) {
            const redisOptions = {
                db: this.options.db || 0,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: this.options.maxRetriesPerRequest || 3,
                enableReadyCheck: true,
                lazyConnect: true
            };
            
            // Add TLS options if provided
            if (this.options.tls) {
                redisOptions.tls = this.options.tls;
            }
            
            this.client = new Redis(this.options.url, redisOptions);
        }

        try {
            // For testing with mocks, check if client has connect method
            if (this.client.connect && typeof this.client.connect === 'function') {
                await this.client.connect();
            } else if (this.client.status !== 'ready') {
                // For real connections, wait for ready event
                await new Promise((resolve, reject) => {
                    this.client.once('ready', resolve);
                    this.client.once('error', reject);
                    // Timeout connection attempt
                    setTimeout(() => reject(new Error('Valkey connection timeout')), 5000);
                });
            }

            this.isReady = true;
            this.connected = true;
            return this;
        } catch (error) {
            throw new Error(`Valkey connection failed: ${error.message}`);
        }
    }

    async get(key) {
        this._checkReady();
        try {
            const data = await this.client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            throw new Error(`Valkey get error: ${error.message}`);
        }
    }

    async set(key, value, ttl = 3600) {
        this._checkReady();
        try {
            const data = JSON.stringify(value);
            if (ttl > 0) {
                await this.client.setex(key, ttl, data);
            } else {
                await this.client.set(key, data);
            }
            return true;
        } catch (error) {
            throw new Error(`Valkey set error: ${error.message}`);
        }
    }

    async delete(key) {
        this._checkReady();
        try {
            const result = await this.client.del(key);
            return result > 0;
        } catch (error) {
            throw new Error(`Valkey delete error: ${error.message}`);
        }
    }

    async exists(key) {
        this._checkReady();
        try {
            const result = await this.client.exists(key);
            return result === 1;
        } catch (error) {
            throw new Error(`Valkey exists error: ${error.message}`);
        }
    }

    async incr(key) {
        this._checkReady();
        try {
            const result = await this.client.incr(key);
            return result;
        } catch (error) {
            throw new Error(`Valkey incr error: ${error.message}`);
        }
    }

    async lock(key, ttl = 60) {
        this._checkReady();
        try {
            const ttlMs = ttl * 1000;
            const result = await this.client.set(key, 1, 'NX', 'PX', ttlMs);
            return result === 'OK';
        } catch (error) {
            throw new Error(`Valkey lock error: ${error.message}`);
        }
    }

    async unlock(key) {
        this._checkReady();
        try {
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
            throw new Error(`Valkey unlock error: ${error.message}`);
        }
    }

    async listKeys(prefix = '', limit = 1000) {
        this._checkReady();
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
            throw new Error(`Valkey listKeys error: ${error.message}`);
        }
    }

    async clear() {
        this._checkReady();
        try {
            await this.client.flushdb();
            return true;
        } catch (error) {
            throw new Error(`Valkey clear error: ${error.message}`);
        }
    }

    async disconnect() {
        if (this.client) {
            if (this.client.quit && typeof this.client.quit === 'function') {
                await this.client.quit();
            } else if (this.client.disconnect && typeof this.client.disconnect === 'function') {
                await this.client.disconnect();
            }
            this.client = null;
            this.isReady = false;
            this.connected = false;
        }
    }

    _checkReady() {
        if (!this.isReady || !this.client) {
            throw new Error('ValkeyCache is not connected');
        }
    }

    getProviderName() {
        return 'Valkey';
    }

    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            name: this.options.name,
            url: this.options.url,
            status: this.isReady ? 'ready' : 'disconnected'
        };
    }

    // Override BaseCache methods to handle type parameter
    async get(key, type = "json") {
        this._checkReady();
        try {
            const data = await this.client.get(key);
            if (!data) return null;
            
            if (type === "json") {
                return JSON.parse(data);
            } else if (type === "text") {
                return data;
            } else if (type === "buffer") {
                return Buffer.from(data);
            }
            return data;
        } catch (error) {
            if (type === "json" && error instanceof SyntaxError) {
                return null;
            }
            throw new Error(`Valkey get error: ${error.message}`);
        }
    }

    async set(key, value, ttl = 3600) {
        this._checkReady();
        try {
            let data;
            if (typeof value === 'string') {
                data = value;
            } else {
                data = JSON.stringify(value);
            }
            
            if (ttl > 0) {
                await this.client.set(key, data, "EX", ttl);
            } else {
                await this.client.set(key, data);
            }
            return true;
        } catch (error) {
            // Handle circular reference errors
            if (error.message.includes('circular') || error.message.includes('Converting circular')) {
                return false;
            }
            throw new Error(`Valkey set error: ${error.message}`);
        }
    }
}

export { ValkeyCache };
