/**
 * BaseCache - Abstract base class for all cache providers
 * Defines the standard interface that all cache implementations must follow
 */

/**
 * @typedef {'json' | 'text' | 'buffer'} CacheValueType
 */

class BaseCache {
    constructor() {
        if (this.constructor === BaseCache) {
            throw new Error("BaseCache is an abstract class and cannot be instantiated directly");
        }
        this.isInitialized = false;
    }

    /**
     * Initialize the cache provider
     * @returns {Promise<void>}
     */
    async initialize() {
        this.isInitialized = true;
    }

    /**
     * Get a value from cache
     * @param {string} key - The cache key
     * @param {CacheValueType} type - The type of value to retrieve
     * @returns {Promise<any>} - The cached value or null if not found
     * @throws {Error} - If not implemented
     */
    async get(key, type = "json") {
        throw new Error('Not implemented');
    }

    /**
     * Set a value in cache
     * @param {string} key - The cache key
     * @param {any} value - The value to cache
     * @param {number} ttl - Time to live in seconds
     * @returns {Promise<boolean>} - Success status
     * @throws {Error} - If not implemented
     */
    async set(key, value, ttl = 3600) {
        throw new Error('Not implemented');
    }

    /**
     * Delete a value from cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - Success status
     * @throws {Error} - If not implemented
     */
    async delete(key) {
        throw new Error('Not implemented');
    }

    /**
     * Check if a key exists in cache
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - True if exists
     * @throws {Error} - If not implemented
     */
    async exists(key) {
        throw new Error('Not implemented');
    }

    /**
     * Increment a numeric value
     * @param {string} key - The cache key
     * @returns {Promise<number>} - The new value
     * @throws {Error} - If not implemented
     */
    async incr(key) {
        throw new Error('Not implemented');
    }

    /**
     * Acquire a lock
     * @param {string} key - The lock key
     * @param {number} ttl - Lock TTL in seconds
     * @returns {Promise<boolean>} - True if lock acquired
     * @throws {Error} - If not implemented
     */
    async lock(key, ttl = 60) {
        throw new Error('Not implemented');
    }

    /**
     * Release a lock
     * @param {string} key - The lock key
     * @returns {Promise<boolean>} - True if lock released
     * @throws {Error} - If not implemented
     */
    async unlock(key) {
        throw new Error('Not implemented');
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'base';
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