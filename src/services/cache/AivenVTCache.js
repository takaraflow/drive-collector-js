/**
 * AivenVTCache.js
 * 
 * Specialized cache for Aiven Valkey service.
 * Auto-detects Aiven specific environment variables and configures TLS automatically.
 * 
 * Aiven typically provides:
 * - VALKEY_HOST
 * - VALKEY_PORT
 * - VALKEY_USER
 * - VALKEY_PASSWORD
 * - VALKEY_CA_CERT (CA Certificate)
 */

import { ValkeyTLSCache } from './ValkeyTLSCache.js';

class AivenVTCache extends ValkeyTLSCache {
    /**
     * Detects Aiven configuration from environment variables.
     * Returns null if Aiven env vars are not present.
     */
    static detectConfig() {
        const host = process.env.VALKEY_HOST;
        const port = process.env.VALKEY_PORT;
        const user = process.env.VALKEY_USER;
        const password = process.env.VALKEY_PASSWORD;
        const caCert = process.env.VALKEY_CA_CERT;

        if (host && port && password) {
            // Construct URL: valkey://user:password@host:port
            // Aiven uses standard Redis protocol
            const authPart = user ? `${user}:${password}@` : `${password}@`;
            const url = `valkey://${authPart}${host}:${port}`;
            
            return {
                url,
                caCert,
                sniServername: host // Aiven requires SNI matching the hostname
            };
        }
        return null;
    }

    constructor(options = {}) {
        // If no options provided, try to auto-detect
        const finalOptions = Object.keys(options).length > 0 
            ? options 
            : AivenVTCache.detectConfig() || {};

        if (!finalOptions.url) {
            throw new Error('AivenVTCache requires valid configuration or environment variables');
        }

        super(finalOptions);
    }

    // Override to return correct provider name
    getProviderName() {
        return 'AivenValkey';
    }

    // Override to include TLS info
    getConnectionInfo() {
        const info = super.getConnectionInfo();
        // Ensure TLS info is included
        info.tls = true;
        return info;
    }
}

export { AivenVTCache };
export default AivenVTCache;