import { CloudflareTunnel } from './tunnel/CloudflareTunnel.js';
import { getConfig } from '../config/index.js';

/**
 * Orchestrator for tunnel operations.
 * Manages the lifecycle of the selected tunnel provider.
 */
class TunnelService {
    constructor() {
        this.provider = null;
    }

    /**
     * Initialize the tunnel service based on application configuration.
     * @returns {Promise<void>}
     */
    async initialize() {
        try {
            const config = getConfig().tunnel;
            if (!config || !config.enabled) {
                return;
            }

            if (config.provider === 'cloudflare') {
                this.provider = new CloudflareTunnel(config);
            } else {
                console.warn(`[TunnelService] Unknown provider: ${config.provider}`);
            }
            
            if (this.provider) {
                console.log(`[TunnelService] Initializing ${config.provider} tunnel...`);
                await this.provider.initialize();
            }
        } catch (error) {
            console.error(`[TunnelService] Initialization failed:`, error.message);
        }
    }

    /**
     * Get the current public URL from the tunnel provider.
     * @returns {Promise<string|null>}
     */
    async getPublicUrl() {
        if (!this.provider) return null;
        return await this.provider.getPublicUrl();
    }

    /**
     * Get the current status of the tunnel.
     * @returns {Object}
     */
    getStatus() {
        if (!this.provider) {
            return { enabled: false };
        }
        return {
            enabled: true,
            ...this.provider.getStatus()
        };
    }

    /**
     * Clean up resources.
     */
    stop() {
        if (this.provider && typeof this.provider.stop === 'function') {
            this.provider.stop();
        }
    }
}

export const tunnelService = new TunnelService();
