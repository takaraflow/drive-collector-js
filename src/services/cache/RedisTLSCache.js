/**
 * RedisTLSCache - Redis cache with forced TLS settings
 * Extends RedisCache to enforce TLS configuration for secure connections
 */

import { RedisCache } from './RedisCache.js';

class RedisTLSCache extends RedisCache {
    /**
     * @param {Object} config - Redis configuration with TLS
     * @param {string} config.host - Redis host
     * @param {number} config.port - Redis port
     * @param {string} config.password - Redis password
     * @param {number} config.db - Redis database (optional, default 0)
     * @param {Object} config.tls - TLS configuration (optional, will be forced)
     */
    constructor(config) {
        // Force TLS configuration
        const tlsConfig = {
            ...config,
            tls: config.tls || {
                // Default TLS settings for Redis
                rejectUnauthorized: false,
                // These can be overridden by passing explicit tls config
            }
        };

        // Ensure maxRetriesPerRequest is set for quick failover
        if (!tlsConfig.maxRetriesPerRequest) {
            tlsConfig.maxRetriesPerRequest = 1;
        }

        super(tlsConfig);
        
        this.tlsConfig = tlsConfig.tls;
        console.log('[RedisTLSCache] Initialized with TLS configuration');
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'RedisTLSCache';
    }

    /**
     * Validate TLS configuration
     * @returns {boolean} - True if TLS is properly configured
     */
    validateTLS() {
        if (!this.tlsConfig) {
            console.warn('[RedisTLSCache] No TLS configuration found');
            return false;
        }
        
        // Check for common TLS misconfigurations
        if (this.tlsConfig.rejectUnauthorized === false) {
            console.warn('[RedisTLSCache] TLS verification is disabled (rejectUnauthorized: false)');
        }
        
        return true;
    }
}

export { RedisTLSCache };