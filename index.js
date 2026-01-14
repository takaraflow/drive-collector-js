import { gracefulShutdown } from "./src/services/GracefulShutdown.js";
import { initConfig, validateConfig, getConfig } from "./src/config/index.js";
import { summarizeStartupConfig } from "./src/utils/startupConfig.js";
import { buildWebhookServer, registerShutdownHooks } from "./src/utils/lifecycle.js";
import { tunnelService } from "./src/services/TunnelService.js";

let appReady = false;

export function setAppReadyState(value) {
    appReady = Boolean(value);
}

/**
 * QStash Webhook 处理程序 (供外部 HTTP Server 或测试使用)
 */
export async function handleQStashWebhook(req, res) {
    const healthPath = '/health';
    const healthzPath = '/healthz';
    const readyPath = '/ready';
    const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
        try {
            const url = new URL(req.url, `http://${hostHeader}`);
            if ([healthPath, healthzPath, readyPath].includes(url.pathname)) {
                if (url.pathname === readyPath && !appReady) {
                    res.writeHead(503);
                    if (req.method === 'HEAD') {
                        res.end();
                    } else {
                        res.end('Not Ready');
                    }
                    return;
                }

                res.writeHead(200);
                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    res.end('OK');
                }
                return;
            }
        } catch (e) {
        }
    }

    if (!appReady) {
        res.writeHead(503);
        res.end('Not Ready');
        return;
    }

    // 其他请求需要导入服务
    const { queueService } = await import("./src/services/QueueService.js");
    const { TaskManager } = await import("./src/processor/TaskManager.js");
    const { logger } = await import("./src/services/logger/index.js");
    const log = logger.withModule ? logger.withModule('App') : logger;

    try {

        // 1. 获取 Body
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }

        // 2. 验证签名
        const signature = req.headers['upstash-signature'];
        const isValid = await queueService.verifyWebhookSignature(signature, body);
        if (!isValid) {
            // 记录签名和部分 body 信息以便调试
            const bodyPreview = body ? body.substring(0, 200) : 'empty';
            log.warn("⚠️ QStash 签名验证失败", {
                signature: signature || 'missing',
                bodyPreview: bodyPreview,
                url: req.url,
                method: req.method
            });
            res.writeHead(401);
            res.end('Unauthorized');
            return;
        }

        // 3. 解析路由和数据
        const url = new URL(req.url, `http://${hostHeader}`);
        const data = JSON.parse(body);
        const path = url.pathname;

        // 检查触发来源
        const triggerSource = data._meta?.triggerSource || 'unknown';
        const instanceId = data._meta?.instanceId || 'unknown';
        
        log.info(`📩 收到 Webhook: ${path}`, { 
            taskId: data.taskId, 
            groupId: data.groupId,
            triggerSource, // 'direct-qstash' 或 'unknown'
            instanceId,
            isFromQStash: triggerSource === 'direct-qstash'
        });

        let result = { success: true, statusCode: 200 };

        if (path.endsWith('/download')) {
            result = await TaskManager.handleDownloadWebhook(data.taskId);
        } else if (path.endsWith('/upload')) {
            result = await TaskManager.handleUploadWebhook(data.taskId);
        } else if (path.endsWith('/batch')) {
            result = await TaskManager.handleMediaBatchWebhook(data.groupId, data.taskIds);
        } else if (path.endsWith('/system-events')) {
            // 系统事件暂只记录不处理
            result = { success: true, statusCode: 200 };
        } else {
            log.warn(`❓ 未知的 Webhook 路径: ${path}`);
        }

        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));

    } catch (error) {
        const { logger } = await import("./src/services/logger/index.js");
        const log = logger.withModule ? logger.withModule('App') : logger;
        log.error("❌ Webhook 处理发生异常:", error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
}

export async function main() {
    await initConfig();

    if (process.argv.includes('--show-config')) {
        setImmediate(async () => {
            try {
                const config = getConfig();
                const { cache } = await import("./src/services/CacheService.js");
                await cache.initialize();

                const summary = await summarizeStartupConfig(config, cache);

                console.log('🔍 最终配置信息:');
                console.log(JSON.stringify(summary, null, 2));
            } catch (error) {
            console.error('❌ 显示配置时出错:', error);
            } finally {
                gracefulShutdown.shutdown('show-config');
            }
        });
        return;
    }

    if (!validateConfig()) {
        console.error("❌ 核心配置缺失，程序停止启动。");
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('config-validation-failed');
        return;
    }

    // 先导入 InstanceCoordinator 以设置 instanceId provider
    // 这必须在任何 logger 使用之前完成
    await import("./src/services/InstanceCoordinator.js");
    
    const { queueService } = await import("./src/services/QueueService.js");
    const { cache } = await import("./src/services/CacheService.js");
    const { d1 } = await import("./src/services/d1.js");
    const { logger } = await import("./src/services/logger/index.js");
    const log = logger.withModule ? logger.withModule('App') : logger;

    console.log("🛠️ 正在初始化核心服务...");
    try {
        // 初始化 logger，确保其他服务可以使用它
        await logger.initialize();
        
        // 然后并行初始化其他服务
        await Promise.all([
            queueService.initialize(),
            cache.initialize(),
            d1.initialize(),
            tunnelService.initialize()
        ]);

        const tunnelUrl = await tunnelService.getPublicUrl();
        if (tunnelUrl) {
            log.info(`🌐 Tunnel active at: ${tunnelUrl}`);
        }

    } catch (err) {
        console.error("❌ 服务初始化失败:", err.message);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('service-initialization-failed', err);
        return;
    }

    await registerShutdownHooks();

    // 先启动 HTTP 服务器，确保 /health 端点始终可用
    const config = getConfig();
    try {
        await buildWebhookServer(config, handleQStashWebhook, log);
        log.info("✅ HTTP 服务器已启动，/health 端点可用");
    } catch (error) {
        log.error("❌ HTTP 服务器启动失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('http-server-failed', error);
        return;
    }

    try {
        const { instanceCoordinator } = await import("./src/services/InstanceCoordinator.js");
        const { startDispatcher } = await import("./src/dispatcher/bootstrap.js");
        const { startProcessor } = await import("./src/processor/bootstrap.js");
        await import("./src/services/telegram.js");

        log.info("🚀 启动业务模块: InstanceCoordinator, Telegram, Dispatcher, Processor");
        
        let businessReady = true;

        // 使用 try-catch 包裹 Telegram 相关启动，确保即使失败也不影响 HTTP 服务器
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
            setAppReadyState(true);
            log.info("✅ 应用启动完成，HTTP 服务器正在运行中");
        } else {
            log.warn("⚠️ 业务模块启动过程中存在异常，health/ready 端点将返回 503 以阻止流量注入");
        }
        
        if (process.env.NODE_ENV !== 'test') {
            setInterval(() => {}, 1000 * 60 * 60);
        }

    } catch (error) {
        log.error("⚠️ 业务模块启动过程中发生错误，但 HTTP 服务器继续运行:", error);
        // 不再因为业务模块错误而退出，HTTP 服务器应该继续运行
    }
}

if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index'))) {
    main().catch(error => {
        console.error("💀 引导程序失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('main-failed', error);
    });
}
