/**
 * ValkeyTLSCache.js
 *
 * Valkey implementation with explicit TLS support.
 * Used for secure connections to managed Valkey instances (e.g., Aiven).
 */

import { ValkeyCache } from './ValkeyCache.js';

class ValkeyTLSCache extends ValkeyCache {
    /**
     * @param {Object} options - Configuration options
     * @param {string} options.url - Valkey connection URL
     * @param {string} [options.sniServername] - Server name for SNI (required for some providers)
     * @param {string} [options.caCert] - CA Certificate string
     * @param {boolean} [options.rejectUnauthorized] - Whether to reject unauthorized certificates
     */
    constructor(options = {}) {
        // Merge TLS options into the connection configuration
        // ioredis supports `tls` option object
        const tlsOptions = {};
        
        // Handle rejectUnauthorized (default to true)
        tlsOptions.rejectUnauthorized = options.rejectUnauthorized !== false;
        
        if (options.sniServername || options.servername) {
            tlsOptions.servername = options.sniServername || options.servername;
        }
        
        if (options.caCert) {
            tlsOptions.ca = options.caCert;
        }

        // Pass modified options to parent with TLS config
        super({
            ...options,
            tls: Object.keys(tlsOptions).length > 0 ? tlsOptions : undefined
        });
    }

    // Override connect to ensure TLS is applied if needed
    async connect() {
        // The parent constructor handles the client creation.
        // We just need to ensure the parent logic runs.
        return super.connect();
    }

    // Override to return correct provider name
    getProviderName() {
        return 'ValkeyTLS';
    }

    // Override to include TLS info
    getConnectionInfo() {
        const info = super.getConnectionInfo();
        // Check if TLS is configured
        const hasTLS = this.options.tls && Object.keys(this.options.tls).length > 0;
        if (hasTLS) {
            info.tls = true;
        }
        return info;
    }
}

export { ValkeyTLSCache };