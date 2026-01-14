import { S6ManagedTunnel } from './S6ManagedTunnel.js';
import { BaseTunnel } from './BaseTunnel.js';

/**
 * Cloudflare Tunnel implementation that monitors a local cloudflared process.
 * @extends S6ManagedTunnel
 */
export class CloudflareTunnel extends S6ManagedTunnel {
    /**
     * @param {Object} config - Tunnel configuration
     */
    constructor(config) {
        super(config);
        const host = config.metricsHost || '127.0.0.1';
        const port = config.metricsPort || 2000;
        this.metricsUrl = `http://${host}:${port}/metrics`;
        this.pollInterval = config.pollInterval || 5000;
        this._timer = null;
    }

    /**
     * Initialize the tunnel and start polling for the URL.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.config.enabled === false) return;
        
        // Wait briefly for service to potentially start
        await this.waitForService(2000);
        
        this._startPolling();
    }

    /**
     * Fetch metrics from the cloudflared process.
     * @returns {Promise<string|null>}
     */
    async _fetchMetrics() {
        try {
            const res = await fetch(this.metricsUrl);
            if (!res.ok) return null;
            return await res.text();
        } catch (error) {
            return null;
        }
    }

    /**
     * Extract the tunnel URL from Prometheus metrics.
     * @param {string} metricsText - The metrics raw text.
     * @returns {string|null}
     */
    extractUrl(metricsText) {
        if (!metricsText) return null;
        
        // Match pattern: cloudflared_tunnel_user_hostname{user_hostname="..."} 1
        // We look for the user_hostname label value
        const match = metricsText.match(/cloudflared_tunnel_user_hostname\{[^}]*user_hostname="([^"]+)"[^}]*\} [0-9.]+/);
        if (match) {
            return `https://${match[1]}`;
        }
        
        // Fallback: search for user_hostname="..." anywhere if the above fails
        const match2 = metricsText.match(/user_hostname="([^"]+)"/);
        if (match2) {
            return `https://${match2[1]}`;
        }
        
        return null;
    }

    /**
     * Polling loop to keep the tunnel URL up to date.
     * @private
     */
    async _startPolling() {
        const poll = async () => {
            try {
                if (!(await this.isServiceUp())) {
                    this.isReady = false;
                    this.currentUrl = null;
                } else {
                    const metrics = await this._fetchMetrics();
                    const url = this.extractUrl(metrics);
                    if (url) {
                        this.currentUrl = url;
                        this.isReady = true;
                    } else {
                        this.isReady = false;
                        this.currentUrl = null;
                    }
                }
            } catch (error) {
                // Silently handle errors in polling loop
            }
            this._timer = setTimeout(poll, this.pollInterval);
        };

        poll();
    }

    /**
     * Clean up resources.
     */
    stop() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
}
