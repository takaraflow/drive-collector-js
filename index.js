import { gracefulShutdown } from "./src/services/GracefulShutdown.js";
import { initConfig, validateConfig, getConfig } from "./src/config/index.js";

let httpServer = null;

/**
 * QStash Webhook 处理程序 (供外部 HTTP Server 或测试使用)
 */
export async function handleQStashWebhook(req, res) {
    const { qstashService } = await import("./src/services/QStashService.js");
    const { TaskManager } = await import("./src/processor/TaskManager.js");
    const { logger } = await import("./src/services/logger.js");
    const log = logger.withModule ? logger.withModule('App') : logger;

    try {
        const healthPath = '/health';
        const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
        if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
            const url = new URL(req.url, `http://${hostHeader}`);
            if (url.pathname === healthPath) {
                res.writeHead(200);
                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    res.end('OK');
                }
                return;
            }
        }

        // 1. 获取 Body
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }

        // 2. 验证签名
        const signature = req.headers['upstash-signature'];
        const isValid = await qstashService.verifyWebhookSignature(signature, body);
        if (!isValid) {
            // 记录签名和部分 body 信息以便调试
            const bodyPreview = body ? body.substring(0, 200) : 'empty';
            log.warn("🚨 QStash 签名验证失败", {
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
        
        log.info(`📥 收到 Webhook: ${path}`, { 
            taskId: data.taskId, 
            groupId: data.groupId,
            triggerSource, // 'direct-qstash' 或 'unknown'
            instanceId,
            isFromQStash: triggerSource === 'direct-qstash'
        });

        let result = { success: true, statusCode: 200 };

        if (path.endsWith('/download-tasks')) {
            result = await TaskManager.handleDownloadWebhook(data.taskId);
        } else if (path.endsWith('/upload-tasks')) {
            result = await TaskManager.handleUploadWebhook(data.taskId);
        } else if (path.endsWith('/media-batch')) {
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
        const { logger } = await import("./src/services/logger.js");
        const log = logger.withModule ? logger.withModule('App') : logger;
        log.error("🚨 Webhook 处理发生异常:", error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
}

/**
 * 注册关闭钩子
 */
async function registerShutdownHooks() {
    const { instanceCoordinator } = await import("./src/services/InstanceCoordinator.js");
    const { cache } = await import("./src/services/CacheService.js");
    const { stopWatchdog, client } = await import("./src/services/telegram.js");
    const { TaskRepository } = await import("./src/repositories/TaskRepository.js");

    // 1. 停止接受新请求 (priority: 10)
    gracefulShutdown.register(async () => {
        if (httpServer) {
            return new Promise((resolve) => {
                httpServer.close(() => {
                    console.log('✅ HTTP Server 已关闭');
                    resolve();
                });
            });
        }
    }, 10, 'http-server');

    // 2. 停止实例协调器 (priority: 20)
    gracefulShutdown.register(async () => {
        await instanceCoordinator.stop();
        console.log('✅ InstanceCoordinator 已停止');
    }, 20, 'instance-coordinator');

    // 3. 停止 Telegram 看门狗和客户端 (priority: 30)
    gracefulShutdown.register(async () => {
        stopWatchdog();
        if (client && client.connected) {
            await client.disconnect();
            console.log('✅ Telegram 客户端已断开');
        }
    }, 30, 'telegram-client');

    // 4. 刷新待处理的任务更新 (priority: 40)
    gracefulShutdown.register(async () => {
        await TaskRepository.flushUpdates();
        console.log('✅ TaskRepository 待更新任务已刷新');
    }, 40, 'task-repository');

    // 5. 断开 Cache 连接 (priority: 50)
    gracefulShutdown.register(async () => {
        await cache.destroy();
        console.log('✅ Cache 服务已断开');
    }, 50, 'cache-service');
}

async function main() {
    // 1. 初始化并加载配置 (从 Infisical 获取)
    await initConfig();

    // 检查是否需要显示配置
    if (process.argv.includes('--show-config')) {
        // 延迟执行，确保没有异步操作干扰
        setImmediate(async () => {
            try {
                console.log('🔍 最终配置信息:');
                const config = getConfig();
                
                //附加 CacheProvider 信息
                const { cache } = await import("./src/services/CacheService.js");
                await cache.initialize();
                
                const finalConfig = {
                    ...config,
                    cache: {
                        currentProvider: cache.getCurrentProvider(),
                        allProviders: cache.providerList.map(p => ({
                            name: p.config.name,
                            type: p.config.type,
                            priority: p.config.priority
                        }))
                    }
                };

                // 输出完整配置
                console.log(JSON.stringify(finalConfig, null, 2));
            } catch (error) {
                console.error('❌ 显示配置时出错:', error);
            } finally {
                // 总是退出，避免 Windows assertion 错误
                gracefulShutdown.shutdown('show-config');
            }
        });
        return; // 退出 main()，等待 setImmediate 执行
    }

    // 2. 验证配置完整性
    if (!validateConfig()) {
        console.error("🚨 核心配置缺失，程序停止启动。");
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('config-validation-failed');
        return;
    }

    // 3. 动态加载核心服务
    const { qstashService } = await import("./src/services/QStashService.js");
    const { cache } = await import("./src/services/CacheService.js");
    const { d1 } = await import("./src/services/d1.js");
    const { logger } = await import("./src/services/logger.js");
    const log = logger.withModule ? logger.withModule('App') : logger;

    // 4. 显式初始化各个服务
    console.log("🔄 正在初始化核心服务...");
    try {
        await Promise.all([
            qstashService.initialize(),
            cache.initialize(),
            d1.initialize()
        ]);
    } catch (err) {
        console.error("❌ 服务初始化失败:", err.message);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('service-initialization-failed', err);
        return;
    }

    // 5. 注册关闭钩子（在启动业务逻辑之前）
    await registerShutdownHooks();

    // 6. 启动业务逻辑
    try {
        const { instanceCoordinator } = await import("./src/services/InstanceCoordinator.js");
        const { startDispatcher } = await import("./src/dispatcher/bootstrap.js");
        const { startProcessor } = await import("./src/processor/bootstrap.js");
        await import("./src/services/telegram.js");

        log.info("🚀 启动业务模块: InstanceCoordinator, Telegram, Dispatcher, Processor");
        
        // 依次启动业务模块
        await instanceCoordinator.start();
        await startDispatcher();
        await startProcessor();

        // 7. 启动 Webhook HTTP Server
        const config = getConfig();
        const http2Config = config.http2 || {};
        if (http2Config.enabled) {
            const http2 = await import("http2");
            if (http2Config.plain) {
                httpServer = http2.createServer({}, handleQStashWebhook);
            } else {
                if (!http2Config.keyPath || !http2Config.certPath) {
                    log.error("?? HTTP/2 已启用，但未配置 TLS 证书路径 (HTTP2_TLS_KEY_PATH/HTTP2_TLS_CERT_PATH)");
                    gracefulShutdown.exitCode = 1;
                    gracefulShutdown.shutdown('http2-tls-missing');
                    return;
                }
                const { readFileSync } = await import("fs");
                httpServer = http2.createSecureServer({
                    key: readFileSync(http2Config.keyPath),
                    cert: readFileSync(http2Config.certPath),
                    allowHTTP1: http2Config.allowHttp1 !== false
                }, handleQStashWebhook);
            }
        } else {
            const http = await import("http");
            httpServer = http.createServer(handleQStashWebhook);
        }
        httpServer.listen(config.port, () => {
            log.info(`🌐 Webhook Server 运行在端口: ${config.port}`);
        });
        
        log.info("🎉 应用启动成功，正在运行中");
        
        // 保持活跃
        if (process.env.NODE_ENV !== 'test') {
            setInterval(() => {}, 1000 * 60 * 60);
        }

    } catch (error) {
        console.error("🚨 应用启动过程中发生致命错误:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('startup-failed', error);
    }
}

// Only run main() when this file is executed directly (not when imported as a module)
// Check if we're in test environment or if this is the main entry point
if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index'))) {
    main().catch(error => {
        console.error("❌ 引导程序失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('main-failed', error);
    });
}
