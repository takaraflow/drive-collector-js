/**
 * BaseCache - Abstract base class for all cache providers
 * Defines the standard interface that all cache implementations must follow
 */

/**
 * @typedef {'json' | 'text' | 'buffer'} CacheValueType
 */

class BaseCache {
    constructor(options = {}) {
        if (this.constructor === BaseCache) {
            throw new Error("BaseCache is an abstract class and cannot be instantiated directly");
        }
        this.options = options;
        this.isInitialized = false;
        this.connected = false;
        this.providerName = this.constructor.name;
    }

    /**
     * Initialize the cache provider
     * @returns {Promise<void>}
     */
    async initialize() {
        this.isInitialized = true;
    }

    /**
     * Connect to the cache provider
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.connected) return;
        if (this._connect) {
            await this._connect();
        }
        this.connected = true;
    }

    /**
     * Disconnect from the cache provider
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.connected) return;
        if (this._disconnect) {
            await this._disconnect();
        }
        this.connected = false;
    }

    /**
     * Get a value from cache
     * @param {string} key - The cache key
     * @param {CacheValueType} type - The type of value to retrieve
     * @returns {Promise<any>} - The cached value or null if not found
     * @throws {Error} - If not connected or not implemented
     */
    async get(key, type = "json") {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._get) {
            return await this._get(key, type);
        }
        throw new Error('Not implemented');
    }

    /**
     * Set a value in cache
     * @param {string} key - The cache key
     * @param {any} value - The value to cache
     * @param {number} ttl - Time to live in seconds
     * @returns {Promise<boolean>} - Success status
     * @throws {Error} - If not connected or not implemented
     */
    async set(key, value, ttl = 3600) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._set) {
            return await this._set(key, value, ttl);
        }
        throw new Error('Not implemented');
    }

    /**
     * Delete a value from cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - Success status
     * @throws {Error} - If not connected or not implemented
     */
    async delete(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._delete) {
            return await this._delete(key);
        }
        throw new Error('Not implemented');
    }

    /**
     * Check if a key exists in cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - True if exists
     * @throws {Error} - If not connected or not implemented
     */
    async exists(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._exists) {
            return await this._exists(key);
        }
        throw new Error('Not implemented');
    }

    /**
     * Increment a numeric value
     * @param {string} key - The cache key
     * @returns {Promise<number>} - The new value
     * @throws {Error} - If not connected or not implemented
     */
    async incr(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._incr) {
            return await this._incr(key);
        }
        throw new Error('Not implemented');
    }

    /**
     * Acquire a lock
     * @param {string} key - The lock key
     * @param {number} ttl - Lock TTL in seconds
     * @returns {Promise<boolean>} - True if lock acquired
     * @throws {Error} - If not connected or not implemented
     */
    async lock(key, ttl = 60) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._lock) {
            return await this._lock(key, ttl);
        }
        throw new Error('Not implemented');
    }

    /**
     * Release a lock
     * @param {string} key - The lock key
     * @returns {Promise<boolean>} - True if lock released
     * @throws {Error} - If not connected or not implemented
     */
    async unlock(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._unlock) {
            return await this._unlock(key);
        }
        throw new Error('Not implemented');
    }

    /**
     * List keys with optional prefix filter
     * @param {string} prefix - Key prefix filter
     * @param {number} limit - Max keys to return
     * @returns {Promise<string[]>} - Array of keys
     * @throws {Error} - If not connected or not implemented
     */
    async listKeys(prefix = '', limit = 1000) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._listKeys) {
            return await this._listKeys(prefix, limit);
        }
        throw new Error('Not implemented');
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return this.providerName;
    }

    /**
     * Get connection information
     * @returns {Object} - Connection info
     */
    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            connected: this.connected
        };
    }

    /**
     * Cleanup resources
     * @returns {Promise<void>}
     */
    async destroy() {
        // Override in subclasses if needed
    }
}

export { BaseCache };
