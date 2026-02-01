import { gracefulShutdown } from '../services/GracefulShutdown.js';
import { initConfig, validateConfig, getConfig } from '../config/index.js';
import { summarizeStartupConfig } from '../utils/startupConfig.js';
import { registerShutdownHooks } from '../utils/lifecycle.js';
import { tunnelService } from '../services/TunnelService.js';

/**
 * 应用初始化器
 */
export class AppInitializer {
    constructor() {
        this.isInitialized = false;
        this.businessModulesRunning = false;
    }

    /**
     * 显示配置信息并退出（用于诊断）
     */
    async showConfig() {
        try {
            const config = getConfig();
            const { cache } = await import("../services/CacheService.js");
            await cache.initialize();

            const summary = await summarizeStartupConfig(config, cache);

            console.log('🔍 最终配置信息:');
            console.log(JSON.stringify(summary, null, 2));
        } catch (error) {
            console.error('❌ 显示配置时出错:', error);
        } finally {
            gracefulShutdown.shutdown('show-config');
        }
    }

    /**
     * 初始化核心服务
     */
    async initializeCoreServices() {
        const { queueService } = await import("../services/QueueService.js");
        const { cache } = await import("../services/CacheService.js");
        const { d1 } = await import("../services/d1.js");
        const { logger } = await import("../services/logger/index.js");
        const log = logger.withModule ? logger.withModule('App') : logger;

        console.log("🛠️ 正在初始化核心服务...");
        try {
            // 确保 Logger 使用最新的配置（包括刚刚拉取的 Infisical 密钥）重新加载
            if (logger.reload) {
                await logger.reload();
            } else {
                await logger.initialize();
            }

            await Promise.all([
                queueService.initialize(),
                cache.initialize(),
                d1.initialize()
            ]);

            // TunnelService 单独初始化，不阻塞主流程
            try {
                await tunnelService.initialize();
                const tunnelUrl = await tunnelService.getPublicUrl();
                if (tunnelUrl) {
                    log.info(`🌐 Tunnel 活跃于: ${tunnelUrl}`);
                }
            } catch (tunnelError) {
                log.warn('TunnelService 初始化失败，将禁用隧道功能:', tunnelError.message);
            }

        } catch (err) {
            console.error("❌ 核心服务初始化失败:", err.message);
            gracefulShutdown.exitCode = 1;
            gracefulShutdown.shutdown('service-initialization-failed', err);
            throw err;
        }
    }

    /**
     * 启动业务模块
     */
    async startBusinessModules() {
        const { logger } = await import("../services/logger/index.js");
        const log = logger.withModule ? logger.withModule('App') : logger;

        if (this.businessModulesRunning) {
            log.info("🔄 业务模块已在运行中，正在尝试重启...");
            await this.stopBusinessModules();
        }

        try {
            const { instanceCoordinator } = await import("../services/InstanceCoordinator.js");
            const { startDispatcher } = await import("../dispatcher/bootstrap.js");
            const { startProcessor } = await import("../processor/bootstrap.js");
            await import("../services/telegram.js");

            log.info("🚀 启动业务模块: InstanceCoordinator, Telegram, Dispatcher, Processor");
            
            let businessReady = true;

            try {
                await instanceCoordinator.start();
            } catch (error) {
                businessReady = false;
                log.error("⚠️ InstanceCoordinator 启动失败，但 HTTP 服务器继续运行:", error);
            }

            try {
                await startDispatcher();
            } catch (error) {
                businessReady = false;
                log.error("⚠️ Dispatcher (Telegram) 启动失败，但 HTTP 服务器继续运行:", error);
            }

            try {
                await startProcessor();
            } catch (error) {
                businessReady = false;
                log.error("⚠️ Processor 启动失败，但 HTTP 服务器继续运行:", error);
            }
            
            if (businessReady) {
                log.info("✅ 应用启动完成");
                this.businessModulesRunning = true;
            } else {
                log.warn("⚠️ 业务模块启动异常");
                this.businessModulesRunning = false;
            }
            
            return businessReady;

        } catch (error) {
            log.error("⚠️ 业务模块启动异常:", error);
            this.businessModulesRunning = false;
            return false;
        }
    }

    /**
     * 停止业务模块
     */
    async stopBusinessModules() {
        const { logger } = await import("../services/logger/index.js");
        const log = logger.withModule ? logger.withModule('App') : logger;
        
        log.info("🛑 正在停止业务模块...");
        try {
            const { instanceCoordinator } = await import("../services/InstanceCoordinator.js");
            const { telegramService } = await import("../services/telegram.js");
            
            // 停止协调器
            if (instanceCoordinator && typeof instanceCoordinator.stop === 'function') {
                await instanceCoordinator.stop();
            }
            
            // 停止 Telegram 服务
            if (telegramService && typeof telegramService.stop === 'function') {
                await telegramService.stop();
            }

            this.businessModulesRunning = false;
            log.info("✅ 业务模块已停止");
        } catch (error) {
            log.error("❌ 停止业务模块时出错:", error);
        }
    }

    /**
     * 保持进程运行
     */
    keepProcessAlive() {
        if (process.env.NODE_ENV !== 'test') {
            setInterval(() => {}, 1000 * 60 * 60);
        }
    }

    /**
     * 初始化应用
     */
    async initialize() {
        if (this.isInitialized) return;

        // 初始化配置
        await initConfig();

        // 显示配置信息并退出（用于诊断）
        if (process.argv.includes('--show-config')) {
            setImmediate(async () => {
                await this.showConfig();
            });
            return;
        }

        // 核心配置校验
        if (!validateConfig()) {
            console.error("❌ 核心配置缺失，程序停止启动。");
            gracefulShutdown.exitCode = 1;
            gracefulShutdown.shutdown('config-validation-failed');
            return;
        }

        // 初始化核心服务
        await this.initializeCoreServices();

        // 注册全局退出钩子
        await registerShutdownHooks();

        this.isInitialized = true;
    }

    /**
     * 启动应用
     */
    async start() {
        await this.initialize();

        // 启动业务模块
        const businessReady = await this.startBusinessModules();

        // 保持进程运行
        this.keepProcessAlive();

        return businessReady;
    }
}
