/**
 * @abstract
 * Base class for all tunnel providers.
 */
export class BaseTunnel {
    /**
     * @param {Object} config - Tunnel configuration
     */
    constructor(config) {
        this.config = config;
        this.currentUrl = null;
        this.isReady = false;
    }

    /**
     * Initialize the tunnel.
     * @abstract
     * @returns {Promise<void>}
     */
    async initialize() {
        throw new Error('Not implemented');
    }

    /**
     * Get the current public URL of the tunnel.
     * @returns {Promise<string|null>}
     */
    async getPublicUrl() {
        return this.currentUrl;
    }

    /**
     * Get the current status of the tunnel.
     * @returns {Object}
     */
    getStatus() {
        return {
            ready: this.isReady,
            url: this.currentUrl,
            provider: this.constructor.name
        };
    }
}
