/**
 * RedisTLSCache - Redis cache with forced TLS settings
 * Extends RedisCache to enforce TLS configuration for secure connections
 */

import { RedisCache } from './RedisCache.js';

class RedisTLSCache extends RedisCache {
    /**
     * @param {Object} config - Redis configuration with TLS
     * @param {string} config.url - Redis connection URL
     * @param {string} config.host - Redis host
     * @param {number} config.port - Redis port
     * @param {string} config.password - Redis password
     * @param {number} config.db - Redis database (optional, default 0)
     * @param {boolean} config.rejectUnauthorized - Whether to reject unauthorized certificates
     * @param {string} config.servername - Server name for SNI
     */
    constructor(config) {
        // Extract TLS-related options
        const { rejectUnauthorized, servername, ...redisOptions } = config;
        
        // Build TLS configuration
        const tlsConfig = {};
        
        // Handle rejectUnauthorized (default to true if not specified)
        if (rejectUnauthorized !== undefined) {
            tlsConfig.rejectUnauthorized = rejectUnauthorized;
        } else {
            tlsConfig.rejectUnauthorized = true;
        }
        
        // Add servername if provided
        if (servername) {
            tlsConfig.servername = servername;
        }

        // Pass modified options to parent with TLS config
        super({
            ...redisOptions,
            tls: Object.keys(tlsConfig).length > 0 ? tlsConfig : undefined
        });
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'RedisTLS';
    }

    /**
     * Get connection information
     * @returns {Object} - Connection info
     */
    getConnectionInfo() {
        const info = super.getConnectionInfo();
        // Include TLS info
        if (this.options.tls) {
            info.tls = true;
        }
        return info;
    }

    /**
     * Validate TLS configuration
     * @returns {boolean} - True if TLS is properly configured
     */
    validateTLS() {
        if (!this.options.tls) {
            console.warn('[RedisTLSCache] No TLS configuration found');
            return false;
        }
        
        // Check for common TLS misconfigurations
        if (this.options.tls.rejectUnauthorized === false) {
            console.warn('[RedisTLSCache] TLS verification is disabled (rejectUnauthorized: false)');
        }
        
        return true;
    }
}

export { RedisTLSCache };