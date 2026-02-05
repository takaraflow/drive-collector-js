import { S6ManagedTunnel } from './S6ManagedTunnel.js';
import { BaseTunnel } from './BaseTunnel.js';
import { logger } from '../logger/index.js';

const log = logger.withModule ? logger.withModule('CloudflareTunnel') : logger;

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
        if (this.config.enabled === false) {
            log.debug('Cloudflare Tunnel is disabled in config');
            return;
        }

        log.debug(`Initializing Cloudflare Tunnel (servicePath: ${this.servicePath})`);

        // Wait briefly for service to potentially start
        const isUp = await this.waitForService(2000);
        if (!isUp) {
            log.debug(`S6 service ${this.servicePath} is not up yet, starting background polling`);
        } else {
            log.debug(`S6 service ${this.servicePath} is up`);
        }

        this._startPolling();
    }

    /**
     * Fetch metrics from the cloudflared process.
     * @returns {Promise<string|null>}
     */
    async _fetchMetrics() {
        try {
            const res = await fetch(this.metricsUrl);
            if (!res.ok) {
                log.debug(`Failed to fetch metrics: ${res.status} ${res.statusText}`);
                return null;
            }
            const text = await res.text();
            return text;
        } catch (error) {
            // Only log if it's not a connection refused (common during startup)
            if (error.cause?.code === 'ECONNREFUSED') {
                log.debug(`Metrics service not reachable at ${this.metricsUrl} (ECONNREFUSED)`);
            } else {
                log.debug(`Error fetching metrics: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Extract the tunnel URL from Prometheus metrics or local file.
     * @param {string} metricsText - The metrics raw text.
     * @returns {Promise<string|null>}
     */
    async extractUrl(metricsText) {
        // 1. Try metrics first (for Named Tunnels)
        if (metricsText) {
            const match = metricsText.match(/cloudflared_tunnel_user_hostname\{[^}]*user_hostname="([^"]+)"[^}]*\} [0-9.]+/);
            if (match) {
                log.debug(`Captured Named Tunnel URL from metrics: ${match[1]}`);
                return `https://${match[1]}`;
            }
            const match2 = metricsText.match(/user_hostname="([^"]+)"/);
            if (match2) {
                log.debug(`Captured URL from metrics (fallback): ${match2[1]}`);
                return `https://${match2[1]}`;
            }
        }

        // 2. Fallback to temporary file (for Quick Tunnels)
        try {
            const fs = await import('fs/promises');
            const filePath = '/tmp/cloudflared.url';
            const content = await fs.readFile(filePath, 'utf8');
            const url = content.trim();
            if (url) {
                log.debug(`Captured Quick Tunnel URL from ${filePath}: ${url}`);
                return url;
            }
            log.debug(`Tunnel URL file ${filePath} exists but is empty`);
            return null;
        } catch (e) {
            if (e.code !== 'ENOENT') {
                log.debug(`Error reading tunnel URL file: ${e.message}`);
            }
            return null;
        }
    }

    /**
     * Polling loop to keep the tunnel URL up to date.
     * @private
     */
    async _startPolling() {
        log.debug(`Starting tunnel URL polling loop (interval: ${this.pollInterval}ms)`);
        const poll = async () => {
            try {
                if (!(await this.isServiceUp())) {
                    if (this.isReady) log.warn('Tunnel service went down');
                    this.isReady = false;
                    this.currentUrl = null;
                } else {
                    const metrics = await this._fetchMetrics();
                    const url = await this.extractUrl(metrics);
                    if (url) {
                        if (this.currentUrl !== url) {
                            log.info(`🚇 Tunnel URL captured: ${url}`);
                        }
                        this.currentUrl = url;
                        this.isReady = true;
                    } else {
                        this.isReady = false;
                        this.currentUrl = null;
                    }
                }
            } catch (error) {
                log.warn(`Error in polling loop: ${error.message}`);
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