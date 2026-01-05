process.on('uncaughtException', (err) => { console.error('FATAL: Uncaught Exception:', err); process.exit(1); })
process.on('unhandledRejection', (reason, promise) => { console.error('FATAL: Unhandled Rejection:', reason); process.exit(1); })

import { initConfig, validateConfig, getConfig } from "./src/config/index.js";

/**
 * QStash Webhook 处理程序 (供外部 HTTP Server 或测试使用)
 */
export async function handleQStashWebhook(req, res) {
    const { qstashService } = await import("./src/services/QStashService.js");
    const { TaskManager } = await import("./src/processor/TaskManager.js");
    const { logger } = await import("./src/services/logger.js");

    try {
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
            logger.warn("🚨 QStash 签名验证失败", {
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
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const data = JSON.parse(body);
        const path = url.pathname;

        logger.info(`📥 收到 QStash Webhook: ${path}`, { taskId: data.taskId, groupId: data.groupId });

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
            logger.warn(`❓ 未知的 Webhook 路径: ${path}`);
        }

        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));

    } catch (error) {
        const { logger } = await import("./src/services/logger.js");
        logger.error("🚨 Webhook 处理发生异常:", error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
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

                // 输出完整配置
                console.log(JSON.stringify(config, null, 2));
            } catch (error) {
                console.error('❌ 显示配置时出错:', error);
            } finally {
                // 总是退出，避免 Windows assertion 错误
                process.exit(0);
            }
        });
        return; // 退出 main()，等待 setImmediate 执行
    }

    // 2. 验证配置完整性
    if (!validateConfig()) {
        console.error("🚨 核心配置缺失，程序停止启动。");
        process.exit(1);
    }

    // 3. 动态加载核心服务
    const { qstashService } = await import("./src/services/QStashService.js");
    const { cache } = await import("./src/services/CacheService.js");
    const { d1 } = await import("./src/services/d1.js");
    const { logger } = await import("./src/services/logger.js");

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
        process.exit(1);
    }

    // 5. 启动业务逻辑
    try {
        const { instanceCoordinator } = await import("./src/services/InstanceCoordinator.js");
        const { startDispatcher } = await import("./src/dispatcher/bootstrap.js");
        const { startProcessor } = await import("./src/processor/bootstrap.js");
        const { connectAndStart, startWatchdog } = await import("./src/services/telegram.js");

        logger.info("🚀 启动业务模块: InstanceCoordinator, Telegram, Dispatcher, Processor");
        
        // 依次启动业务模块
        await instanceCoordinator.start();
        await connectAndStart();
        await startDispatcher();
        await startProcessor();
        startWatchdog();

        // 6. 启动 Webhook HTTP Server
        const http = await import("http");
        const config = getConfig();
        const server = http.createServer(handleQStashWebhook);
        server.listen(config.port, () => {
            logger.info(`🌐 Webhook Server 运行在端口: ${config.port}`);
        });
        
        logger.info("🎉 应用启动成功，正在运行中");
        
        // 保持活跃
        if (process.env.NODE_ENV !== 'test') {
            setInterval(() => {}, 1000 * 60 * 60);
        }

    } catch (error) {
        console.error("🚨 应用启动过程中发生致命错误:", error);
        process.exit(1);
    }
}

// Only run main() when this file is executed directly (not when imported as a module)
// Check if we're in test environment or if this is the main entry point
if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index'))) {
    main().catch(error => {
        console.error("❌ 引导程序失败:", error);
        process.exit(1);
    });
}


