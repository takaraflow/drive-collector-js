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
    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
        try {
            if ([healthPath, healthzPath, readyPath].includes(path)) {
                if (path === readyPath && !appReady) {
                    res.writeHead(503);
                    res.end(req.method === 'HEAD' ? '' : 'Not Ready');
                    return;
                }
                res.writeHead(200);
                res.end(req.method === 'HEAD' ? '' : 'OK');
                return;
            }
        } catch (e) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
        }
    }

    if (!appReady) {
        res.writeHead(503);
        res.end('Not Ready');
        return;
    }

    // --- 新增：实时流式转发 API V2 ---
    
    // 1. 处理文件流 (Worker 端)
    if (path.startsWith('/api/v2/stream/') && req.method === 'POST') {
        const taskId = path.split('/').pop();
        const { streamTransferService } = await import("./src/services/StreamTransferService.js");
        const result = await streamTransferService.handleIncomingChunk(taskId, req);
        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));
        return;
    }

    // 2. 处理状态更新 (Leader 端)
    if (path.startsWith('/api/v2/tasks/') && path.endsWith('/status') && req.method === 'POST') {
        const parts = path.split('/');
        const taskId = parts[parts.length - 2];
        
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }
        
        const { streamTransferService } = await import("./src/services/StreamTransferService.js");
        const result = await streamTransferService.handleStatusUpdate(taskId, JSON.parse(body), req.headers);
        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));
        return;
    }

    // --- 原有的 QStash Webhook 逻辑 ---
    // 其他请求需要导入服务
    const { queueService } = await import("./src/services/QueueService.js");
    const { TaskManager } = await import("./src/processor/TaskManager.js");
    const { logger } = await import("./src/services/logger/index.js");
    const log = logger.withModule ? logger.withModule('App') : logger;

    try {
        const signature = req.headers['upstash-signature'];
        if (!signature) {
            res.writeHead(401);
            res.end('Unauthorized');
            return;
        }

        // 1. 获取 Body
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }

        // 2. 验证签名
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

        // 3. 解析数据
        const url = new URL(req.url, `http://${hostHeader}`);
        const data = JSON.parse(body);
        const path = url.pathname;

        // 详细 metadata 记录和触发源校验
        const _meta = data._meta || {};
        const triggerSource = _meta.triggerSource || 'unknown';
        const instanceId = _meta.instanceId || 'unknown';
        const groupId = data.groupId || _meta.groupId || 'unknown';
        const timestamp = _meta.timestamp || Date.now();

        log.info(`📩 收到 Webhook: ${path}`, { 
            taskId: data.taskId, 
            groupId,
            triggerSource, 
            instanceId,
            timestamp,
            isFromQStash: triggerSource === 'direct-qstash',
            metadata: _meta
        });
        let result = { success: true, statusCode: 200 };

        if (path.endsWith('/download')) {
            result = await TaskManager.handleDownloadWebhook(data.taskId);
        } else if (path.endsWith('/upload')) {
            result = await TaskManager.handleUploadWebhook(data.taskId);
        } else if (path.endsWith('/batch')) {
            result = await TaskManager.handleMediaBatchWebhook(data.groupId, data.taskIds);
        } else if (path.endsWith('/system-events')) {
            result = { success: true, statusCode: 200 };
        } else {
            log.warn(`❓ 未知的 Webhook 路径: ${path}`);
        }

        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));

    } catch (error) {
        console.error("❌ Request handling error:", error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
}

export async function main() {
    // 初始化配置
    await initConfig();

    // 显示配置信息并退出 (用于诊断)
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

    // 核心配置校验
    if (!validateConfig()) {
        console.error("❌ 核心配置缺失，程序停止启动。");
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('config-validation-failed');
        return;
    }

    // 导入核心服务（在此导入以确保配置已加载）
    const { queueService } = await import("./src/services/QueueService.js");
    const { cache } = await import("./src/services/CacheService.js");
    const { d1 } = await import("./src/services/d1.js");
    const { logger } = await import("./src/services/logger/index.js");
    const log = logger.withModule ? logger.withModule('App') : logger;

    console.log("🛠️ 正在初始化核心服务...");
    try {
        await logger.initialize();
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

    // 注册全局退出钩子
    await registerShutdownHooks();

    // 先启动 HTTP 服务器，确保 /health 端点始终可用
    const config = getConfig();
    try {
        await buildWebhookServer(config, handleQStashWebhook, log);
        log.info("✅ HTTP 服务器已启动");
    } catch (error) {
        log.error("❌ HTTP 服务器启动失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('http-server-failed', error);
        return;
    }

    // 启动业务逻辑
    try {
        const { instanceCoordinator } = await import("./src/services/InstanceCoordinator.js");
        const { startDispatcher } = await import("./src/dispatcher/bootstrap.js");
        const { startProcessor } = await import("./src/processor/bootstrap.js");
        await import("./src/services/telegram.js");

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
            setAppReadyState(true);
            log.info("✅ 应用启动完成");
        } else {
            log.warn("⚠️ 业务模块启动异常");
        }
        
        // 保持进程运行
        if (process.env.NODE_ENV !== 'test') {
            setInterval(() => {}, 1000 * 60 * 60);
        }

    } catch (error) {
        log.error("⚠️ 业务模块启动异常:", error);
    }
}

// 执行主函数
if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index'))) {
    main().catch(error => {
        console.error("💀 引导程序失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('main-failed', error);
    });
}