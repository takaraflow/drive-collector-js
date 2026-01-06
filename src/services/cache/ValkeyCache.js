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
        super();
        this.options = options;
        this.client = null;
        this.isReady = false;
    }

    async connect() {
        if (this.client) return this;

        try {
            // Use ioredis for Valkey compatibility
            this.client = new Redis(this.options.url, {
                db: this.options.db || 0,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                maxRetriesPerRequest: this.options.maxRetriesPerRequest || 3,
                enableReadyCheck: true,
                lazyConnect: false
            });

            await new Promise((resolve, reject) => {
                this.client.once('ready', resolve);
                this.client.once('error', reject);
                // Timeout connection attempt
                setTimeout(() => reject(new Error('Valkey connection timeout')), 5000);
            });

            this.isReady = true;
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
            await this.client.del(key);
            return true;
        } catch (error) {
            throw new Error(`Valkey delete error: ${error.message}`);
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
            await this.client.quit();
            this.client = null;
            this.isReady = false;
        }
    }

    _checkReady() {
        if (!this.isReady || !this.client) {
            throw new Error('ValkeyCache is not connected');
        }
    }
}

export { ValkeyCache };