import { buildWebhookServer } from '../utils/lifecycle.js';
import { handleWebhook, setAppReadyState } from '../webhook/WebhookRouter.js';
import { gracefulShutdown } from '../services/GracefulShutdown.js';

/**
 * HTTP服务器管理器
 */
export class HttpServer {
    constructor(config) {
        this.config = config;
        this.server = null;
        this.isStarted = false;
    }

    /**
     * 启动HTTP服务器
     */
    async start() {
        if (this.isStarted) return;

        const { logger } = await import("../services/logger/index.js");
        const log = logger.withModule ? logger.withModule('HttpServer') : logger;

        try {
            // 先启动 HTTP 服务器，确保 /health 端点始终可用
            this.server = await buildWebhookServer(this.config, handleWebhook, log);
            log.info("✅ HTTP 服务器已启动");
            
            // 设置应用就绪状态
            setAppReadyState(true);
            this.isStarted = true;
            
        } catch (error) {
            log.error("❌ HTTP 服务器启动失败:", error);
            gracefulShutdown.exitCode = 1;
            gracefulShutdown.shutdown('http-server-failed', error);
            throw error;
        }
    }

    /**
     * 停止HTTP服务器
     */
    async stop() {
        if (!this.isStarted) return;

        const { logger } = await import("../services/logger/index.js");
        const log = logger.withModule ? logger.withModule('HttpServer') : logger;

        try {
            if (this.server && typeof this.server.close === 'function') {
                await new Promise((resolve, reject) => {
                    this.server.close((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }
            
            log.info("🛑 HTTP 服务器已停止");
            this.isStarted = false;
            setAppReadyState(false);
            
        } catch (error) {
            log.error("❌ HTTP 服务器停止失败:", error);
            throw error;
        }
    }

    /**
     * 获取服务器状态
     */
    getStatus() {
        return {
            isStarted: this.isStarted,
            config: this.config
        };
    }
}