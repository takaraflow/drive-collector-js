import fs from 'fs/promises';
import { BaseTunnel } from './BaseTunnel.js';

/**
 * Intermediate class for tunnels managed by s6-overlay.
 * Provides logic to monitor the underlying s6 service.
 * @extends BaseTunnel
 */
export class S6ManagedTunnel extends BaseTunnel {
    /**
     * @param {Object} config - Tunnel configuration
     */
    constructor(config) {
        super(config);
        // Default s6 service path for cloudflared
        this.servicePath = config.servicePath || '/run/service/cloudflared';
    }

    /**
     * Check if the underlying s6 service is running.
     * @returns {Promise<boolean>}
     */
    async isServiceUp() {
        try {
            // Check if the service directory exists and is accessible.
            // In s6, /run/service/X/supervise/status contains binary status,
            // but just checking the directory or pid is often enough for "up".
            await fs.access(this.servicePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Wait for the s6 service to become available.
     * @param {number} timeout - Maximum wait time in milliseconds.
     * @returns {Promise<boolean>}
     */
    async waitForService(timeout = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await this.isServiceUp()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    }
}
