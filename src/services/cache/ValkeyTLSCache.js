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
     */
    constructor(options = {}) {
        // Merge TLS options into the connection configuration
        // ioredis supports `tls` option object
        const tlsOptions = {};
        
        if (options.sniServername) {
            tlsOptions.servername = options.sniServername;
        }
        
        if (options.caCert) {
            tlsOptions.ca = options.caCert;
        }

        // If URL is not secure (rediss://), force it or warn?
        // We assume the URL provided is correct.
        
        // Pass modified options to parent
        super({
            ...options,
            // ioredis specific TLS config
            tls: Object.keys(tlsOptions).length > 0 ? tlsOptions : undefined
        });
    }

    // Override connect to ensure TLS is applied if needed
    async connect() {
        // The parent constructor handles the client creation.
        // We just need to ensure the parent logic runs.
        return super.connect();
    }
}

export { ValkeyTLSCache };