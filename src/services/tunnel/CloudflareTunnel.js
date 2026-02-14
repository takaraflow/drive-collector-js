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
            // 在这里不调用 s6-svc -d，因为 s6 服务应该由 s6 自身管理其生命周期
            // 如果禁用，那么 s6 就不应该启动 cloudflared
            return;
        }

        log.debug(`Initializing Cloudflare Tunnel (Managed by s6)`);

        // 在 s6 环境中，cloudflared 由 s6 管理，但需要 Node.js 在加载完 Infisical 凭证后手动启动
        // 因为 cloudflared 服务有 'down' 文件，不会自动启动
        await this._controlS6Service('-u');

        this._startPolling();
    }

    /**
     * Control the s6 service using s6-svc. (Removed as Node.js should not control s6 services directly)
     * @param {string} action - The s6-svc action flag (e.g., '-u' for up, '-d' for down)
     * @private
     */
    async _controlS6Service(action) {
        log.debug(`Controlling s6 service with action: ${action}`);
        try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);

            const servicePath = '/run/service/cloudflared';
            
            try {
                await execAsync(`s6-svc ${action} ${servicePath}`);
                log.info(`Sent s6-svc ${action} signal to ${servicePath}`);
            } catch (e) {
                // 如果在非 s6 环境（如普通 Windows 开发环境），只记录 debug 日志
                if (process.platform !== 'win32') {
                    log.debug(`s6-svc signal failed (expected if not in s6): ${e.message}`);
                }
            }
        } catch (error) {
            log.error(`Error controlling s6 service: ${error.message}`);
        }
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
                log.info(`Captured Quick Tunnel URL from ${filePath}: ${url}`);
                return url;
            }
            log.warn(`Tunnel URL file ${filePath} exists but is empty`);
            return null;
        } catch (e) {
            const currentFilePath = '/tmp/cloudflared.url'; // 确保 filePath 可用
            if (e.code !== 'ENOENT') {
                log.error(`Error reading tunnel URL file ${currentFilePath}: ${e.message}`, e); // 包含 e 对象以获取堆栈
            } else {
                log.debug(`Tunnel URL file ${currentFilePath} not found yet`);
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
                // 同时尝试从 Metrics 和 文件 提取
                const metrics = await this._fetchMetrics();
                const url = await this.extractUrl(metrics);

                if (url) {
                    if (this.currentUrl !== url) {
                        log.info(`🚇 Tunnel URL captured: ${url}`);
                    }
                    this.currentUrl = url;
                    this.isReady = true;
                } else {
                    // 如果没拿到 URL，检查服务是否真的挂了
                    const isServiceUp = await this.isServiceUp();

                    if (!isServiceUp) {
                        // 只有当服务确认挂掉时，才置空
                        if (this.isReady) log.warn('Tunnel service is down, clearing URL');
                        this.isReady = false;
                        this.currentUrl = null;
                    }
                    // 如果服务还在启动中 (isServiceUp 为 true 但 url 为空)，
                    // 保持现状，不做任何处理，等待下一轮轮询抓取 URL
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