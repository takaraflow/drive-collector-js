/**
 * ValkeyHTTPCache - Valkey cache provider via HTTP
 * Currently a placeholder/extension of RedisHTTPCache
 * Valkey HTTP standard is not yet unified, but this provides a base for future HTTP-based Valkey services
 */

import { RedisHTTPCache } from './RedisHTTPCache.js';

class ValkeyHTTPCache extends RedisHTTPCache {
    /**
     * @param {Object} config - Valkey HTTP configuration
     * @param {string} config.url - Valkey HTTP endpoint URL
     * @param {string} config.token - Authentication token
     */
    constructor(config) {
        super(config);
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'ValkeyHTTPCache';
    }
}

export { ValkeyHTTPCache };