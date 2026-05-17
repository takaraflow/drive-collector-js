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
        this._process = null;
        this._startedStandalone = false;
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
        const startedByS6 = await this._controlS6Service('-u');
        if (!startedByS6) {
            await this._startStandaloneProcess();
        }

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
            const { execFile } = await import('child_process');
            const { promisify } = await import('util');
            const execFileAsync = promisify(execFile);
            const fs = await import('fs/promises');
            const s6SvcPath = '/command/s6-svc';

            try {
                await fs.access(s6SvcPath);
            } catch {
                log.warn(`s6-svc not available at ${s6SvcPath}, falling back to standalone cloudflared`);
                return false;
            }

            const servicePath = this.servicePath || '/run/service/cloudflared';
            
            // Wait for s6-rc to create the service directory
            log.info(`Waiting for s6 service directory: ${servicePath}`);
            let attempts = 0;
            const maxAttempts = 30;
            while (attempts < maxAttempts) {
                try {
                    await fs.access(servicePath);
                    log.info(`Service directory exists: ${servicePath}`);
                    break;
                } catch {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        log.warn(`s6 service directory did not become ready: ${servicePath}; falling back to standalone cloudflared`);
                        return false;
                    }
                    log.debug(`Service directory not ready yet, waiting... (${attempts}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            if (typeof action !== 'string' || !/^-[a-zA-Z]$/.test(action)) {
                throw new Error('Invalid action flag');
            }

            if (typeof servicePath !== 'string' || !servicePath.startsWith('/') || servicePath.includes('..')) {
                throw new Error('Invalid service path');
            }

            log.info(`Executing: ${s6SvcPath} ${action} ${servicePath}`);
            const { stdout, stderr } = await execFileAsync(s6SvcPath, [action, servicePath]);
            if (stdout) log.debug(`s6-svc stdout: ${stdout}`);
            if (stderr) log.warn(`s6-svc stderr: ${stderr}`);
            log.info(`Successfully sent s6-svc ${action} signal to ${servicePath}`);
            return true;
        } catch (error) {
            // 记录错误但不抛出，避免阻塞应用启动
            // 在 s6 环境中，这是错误；在非 s6 环境（如 Windows 开发环境），这是预期的
            if (process.platform !== 'win32') {
                log.error(`Failed to execute s6-svc ${action}: ${error.message}`);
            } else {
                log.debug(`s6-svc not available (expected on Windows): ${error.message}`);
            }
            return false;
        }
    }

    /**
     * Start a standalone cloudflared process when s6-overlay is unavailable.
     * This supports constrained platforms that do not allow /init to run as PID 1.
     * @returns {Promise<void>}
     * @private
     */
    async _startStandaloneProcess() {
        if (this._process) {
            return;
        }

        const { spawn } = await import('child_process');
        const appPort = process.env.PORT || '7860';
        const metricsAddress = `${this.config.metricsHost || '127.0.0.1'}:${this.config.metricsPort || 2000}`;
        const args = [
            'tunnel',
            '--url',
            `http://127.0.0.1:${appPort}`,
            '--metrics',
            metricsAddress,
            '--no-autoupdate'
        ];

        log.info(`Starting standalone cloudflared process for ${args[2]} with metrics on ${metricsAddress}`);

        const proc = spawn('cloudflared', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        this._process = proc;
        this._startedStandalone = true;

        const captureUrl = async (chunk) => {
            const text = chunk.toString();
            const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
            if (match) {
                const url = match[0];
                if (this.currentUrl !== url) {
                    log.info(`🚇 Tunnel URL captured from cloudflared output: ${url}`);
                }
                this.currentUrl = url;
                this.isReady = true;

                try {
                    const fs = await import('fs/promises');
                    await fs.writeFile('/tmp/cloudflared.url', `${url}\n`, 'utf8');
                } catch (error) {
                    log.debug(`Failed to persist tunnel URL to /tmp/cloudflared.url: ${error.message}`);
                }
            }

            const trimmed = text.trim();
            if (trimmed) {
                log.debug(`[cloudflared] ${trimmed}`);
            }
        };

        proc.stdout?.on('data', (chunk) => {
            void captureUrl(chunk);
        });
        proc.stderr?.on('data', (chunk) => {
            void captureUrl(chunk);
        });
        proc.on('error', (error) => {
            log.error(`Standalone cloudflared process failed to start: ${error.message}`);
            this._process = null;
        });
        proc.on('exit', (code, signal) => {
            log.warn(`Standalone cloudflared exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
            this._process = null;
            if (!this.currentUrl) {
                this.isReady = false;
            }
        });
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

        if (this._startedStandalone && this.currentUrl) {
            return this.currentUrl;
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
        if (this._process) {
            this._process.kill('SIGTERM');
            this._process = null;
        }
    }
}
