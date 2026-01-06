/**
 * MemoryCache - L2 Fallback Provider
 * Simplified in-memory cache provider with max key limit
 * Used as the ultimate fallback when all other providers fail
 */

import { BaseCache } from './BaseCache.js';

class MemoryCache extends BaseCache {
    constructor(maxKeys = 1000) {
        super();
        this.cache = new Map();
        this.ttls = new Map();
        this.maxKeys = maxKeys;
        this.providerName = 'memory';
    }

    async initialize() {
        // Memory cache doesn't need async initialization
        this.isInitialized = true;
    }

    /**
     * Enforce max key limit by removing oldest entries if needed
     */
    _enforceMaxKeys() {
        if (this.cache.size > this.maxKeys) {
            // Remove oldest 10% of keys
            const keysToRemove = Math.floor(this.maxKeys * 0.1);
            const entries = Array.from(this.cache.entries());
            
            // Sort by TTL (oldest first)
            entries.sort((a, b) => {
                const ttlA = this.ttls.get(a[0]) || 0;
                const ttlB = this.ttls.get(b[0]) || 0;
                return ttlA - ttlB;
            });

            // Remove oldest entries
            for (let i = 0; i < keysToRemove && i < entries.length; i++) {
                const key = entries[i][0];
                this.cache.delete(key);
                this.ttls.delete(key);
            }
        }
    }

    /**
     * Check if key is expired and clean up if needed
     */
    _checkExpiry(key) {
        const expiry = this.ttls.get(key);
        if (expiry && Date.now() > expiry) {
            this.cache.delete(key);
            this.ttls.delete(key);
            return true;
        }
        return false;
    }

    async get(key, type = "json") {
        if (!this.cache.has(key)) return null;
        
        if (this._checkExpiry(key)) return null;

        const value = this.cache.get(key);
        
        // Handle different types
        if (type === "json") {
            return value;
        } else if (type === "text") {
            return typeof value === 'string' ? value : JSON.stringify(value);
        } else if (type === "buffer") {
            return Buffer.from(JSON.stringify(value));
        }
        
        return value;
    }

    async set(key, value, ttl = 3600) {
        // Enforce max keys before adding new entry
        this._enforceMaxKeys();

        this.cache.set(key, value);
        this.ttls.set(key, Date.now() + (ttl * 1000));
        
        return true;
    }

    async delete(key) {
        const deleted = this.cache.delete(key);
        this.ttls.delete(key);
        return deleted;
    }

    async exists(key) {
        if (!this.cache.has(key)) return false;
        return !this._checkExpiry(key);
    }

    async incr(key) {
        const current = await this.get(key);
        if (current === null) {
            await this.set(key, 1, 3600);
            return 1;
        }
        
        const newValue = (typeof current === 'number' ? current : parseInt(current)) + 1;
        await this.set(key, newValue, 3600);
        return newValue;
    }

    async lock(key, ttl = 60) {
        const lockKey = `__lock:${key}`;
        if (this.cache.has(lockKey)) {
            return false;
        }
        
        await this.set(lockKey, true, ttl);
        return true;
    }

    async unlock(key) {
        const lockKey = `__lock:${key}`;
        return await this.delete(lockKey);
    }

    /**
     * List keys with optional prefix filter
     * @param {string} prefix - Key prefix filter
     * @returns {Promise<string[]>} - Array of keys
     */
    async listKeys(prefix = '') {
        const keys = [];
        const searchPattern = prefix ? `${prefix}*` : '*';
        
        for (const key of this.cache.keys()) {
            // Check if key matches pattern
            if (this._keyMatchesPattern(key, searchPattern)) {
                // Check expiry
                if (!this._checkExpiry(key)) {
                    keys.push(key);
                }
            }
        }
        
        return keys;
    }

    /**
     * Bulk set multiple values
     * @param {Array} pairs - Array of {key, value} objects
     * @returns {Promise<Array>} - Results
     */
    async bulkSet(pairs) {
        const results = [];
        
        for (const pair of pairs) {
            try {
                if (!pair || typeof pair.key !== 'string' || pair.value === undefined) {
                    results.push({ success: false, error: 'Invalid pair' });
                    continue;
                }
                
                const success = await this.set(pair.key, pair.value, 3600);
                results.push({ success, result: success ? 'OK' : 'ERROR' });
            } catch (error) {
                results.push({ success: false, error: error.message });
            }
        }
        
        return results;
    }

    /**
     * Check if key matches pattern (simple wildcard support)
     * @private
     */
    _keyMatchesPattern(key, pattern) {
        if (pattern === '*') return true;
        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            return key.startsWith(prefix);
        }
        return key === pattern;
    }

    getProviderName() {
        return this.providerName;
    }

    /**
     * Get cache statistics for monitoring
     */
    getStats() {
        return {
            size: this.cache.size,
            maxKeys: this.maxKeys,
            provider: this.providerName
        };
    }

    async destroy() {
        this.cache.clear();
        this.ttls.clear();
    }
}

export { MemoryCache };