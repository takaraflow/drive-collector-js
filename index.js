import http from "http";
import { config } from "./src/config/index.js";
import { SettingsRepository } from "./src/repositories/SettingsRepository.js";
import { instanceCoordinator } from "./src/services/InstanceCoordinator.js";
import { qstashService } from "./src/services/QStashService.js";
import { TaskManager } from "./src/processor/TaskManager.js";
import { startDispatcher } from "./src/dispatcher/bootstrap.js";
import { startProcessor, stopProcessor } from "./src/processor/bootstrap.js";
import { logger } from "./src/services/logger.js";

/**
 * --- 🛡️ 全局错误处理 ---
 */
process.on("unhandledRejection", (reason, promise) => {
    logger.error("🚨 未捕获的 Promise 拒绝:", reason);
});

process.on("uncaughtException", (err) => {
    logger.error("🚨 未捕获的异常:", err);
    // 对于 TIMEOUT 错误，我们通常希望程序继续运行并由 Watchdog 处理
    if (err?.message?.includes("TIMEOUT")) {
        logger.warn("⚠️ 忽略 TIMEOUT 导致的进程崩溃风险...");
    } else {
        // 其他严重错误建议安全退出
        // process.exit(1);
    }
});

/**
 * 处理 QStash Webhook 请求
 */
async function handleQStashWebhook(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathParts = url.pathname.split('/').filter(Boolean);
        const topic = pathParts[2]; // /api/tasks/{topic}

        // 读取请求体
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString();
        const data = JSON.parse(body);

        // 验证签名
        const signature = req.headers['upstash-signature'];
        if (!(await qstashService.verifyWebhookSignature(signature, body))) {
            res.writeHead(401);
            res.end('Unauthorized');
            return;
        }

        logger.info(`🎣 收到 QStash Webhook: ${topic}`, data);

        // 根据 topic 分发处理
        switch (topic) {
            case 'download-tasks':
                await TaskManager.handleDownloadWebhook(data.taskId);
                break;
            case 'upload-tasks':
                await TaskManager.handleUploadWebhook(data.taskId);
                break;
            case 'media-batch':
                await TaskManager.handleMediaBatchWebhook(data.groupId, data.taskIds || []);
                break;
            case 'system-events':
                // 处理系统事件广播
                logger.info(`📢 系统事件: ${data.event}`, data);
                break;
            default:
                logger.warn(`⚠️ 未知的 Webhook topic: ${topic}`);
        }

        res.writeHead(200);
        res.end('OK');
    } catch (error) {
        logger.error('❌ Webhook 处理失败:', error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
}

/**
 * --- 🚀 应用程序入口 ---
 */

export { handleQStashWebhook };
(async () => {
    try {
        logger.info("🔄 正在启动应用...");

        // 检查 NODE_MODE 环境变量（支持向后兼容旧名称）
        const modeMapping = { bot: 'dispatcher', worker: 'processor' };
        let nodeMode = process.env.NODE_MODE || 'all';
        nodeMode = modeMapping[nodeMode] || nodeMode;
        if (!['all', 'dispatcher', 'processor'].includes(nodeMode)) {
            logger.error("❌ NODE_MODE 必须是 'all', 'dispatcher' 或 'processor' 之一");
            process.exit(1);
        }

        // --- 🛡️ 启动退避机制 (Startup Backoff) ---
        try {
            const lastStartup = await SettingsRepository.get("last_startup_time", "0");
            const now = Date.now();
            const diff = now - parseInt(lastStartup);

            // 如果两次启动间隔小于 60 秒，触发退避
            if (diff < 60 * 1000) {
                const crashCount = parseInt(await SettingsRepository.get("recent_crash_count", "0")) + 1;
                await SettingsRepository.set("recent_crash_count", crashCount.toString());

                // 指数级增加退避时间：基础 10s * crashCount，最大 5 分钟
                const backoffSeconds = Math.min(10 * crashCount + Math.floor((60 * 1000 - diff) / 1000), 300);

                logger.warn(`⚠️ 检测到频繁重启 (次数: ${crashCount}, 间隔: ${Math.floor(diff/1000)}s)，启动退避：休眠 ${backoffSeconds}s...`);
                await new Promise(r => setTimeout(r, backoffSeconds * 1000));
            } else {
                // 如果启动间隔正常，重置崩溃计数
                await SettingsRepository.set("recent_crash_count", "0");
            }
            await SettingsRepository.set("last_startup_time", Date.now().toString());
        } catch (settingsError) {
            logger.warn("⚠️ 启动退避逻辑执行失败 (D1/KV 异常)，跳过退避，直接启动:", settingsError);
        }

        // 2. 启动 HTTP 服务器 (健康检查 + QStash Webhook)
        const server = http.createServer(async (req, res) => {
            // QStash Webhook 处理
            if (req.method === 'POST' && req.url?.startsWith('/api/tasks/')) {
                await handleQStashWebhook(req, res);
                return;
            }

            // 健康检查
            res.writeHead(200);
            res.end(`${nodeMode.charAt(0).toUpperCase() + nodeMode.slice(1)} Node Active`);
        });

        server.listen(config.port, '0.0.0.0', () => {
            logger.info(`📡 HTTP 服务器端口 ${config.port} 已就绪`);
        });

        // 3. 初始化实例协调器（多实例支持）
        await instanceCoordinator.start();

        // 根据 NODE_MODE 调用相应引导函数
        if (nodeMode === 'all' || nodeMode === 'processor') {
            await startProcessor();
        }

        if (nodeMode === 'all' || nodeMode === 'dispatcher') {
            await startDispatcher();

            // 启动后台预热：扫描有绑定网盘的用户并预热文件列表
            (async () => {
                try {
                    const { DriveRepository } = await import("./src/repositories/DriveRepository.js");
                    const { CloudTool } = await import("./src/services/rclone.js");
                    const activeDrives = await DriveRepository.findAll();
                    if (activeDrives.length > 0) {
                        logger.info(`🔥 正在预热 ${activeDrives.length} 个用户的云端文件列表...`);
                        // 使用并行但受限的方式预热，避免启动时瞬间 Rclone 爆炸
                        for (const drive of activeDrives) {
                            CloudTool.listRemoteFiles(drive.user_id, true).catch(() => {});
                            await new Promise(r => setTimeout(r, 2000)); // 每 2s 启动一个预热
                        }
                    }
                } catch (e) {
                    logger.error("❌ 预热失败:", e);
                }
            })();
        }

        // 6. 设置优雅关闭处理
// 新增：关闭 HTTP 服务器版本，遵循计划
        const gracefulShutdown = async (signal) => {
            logger.info(`\n📴 收到 ${signal} 信号，正在优雅关闭...`);

            try {
                // 新增：关闭 HTTP 服务器
                server.close((err) => {
                    if (err) {
                        logger.error("❌ 服务器关闭失败:", err);
                        process.exit(1);
                        return;
                    }
                    logger.info("🔌 HTTP 服务器已关闭");

                    // 停止实例协调器
                    instanceCoordinator.stop().then(() => {
                        // 停止 Processor 组件（如果已启动）
                        if (nodeMode === 'all' || nodeMode === 'processor') {
                            stopProcessor().then(() => {
                                logger.info("✅ 优雅关闭完成");
                                process.exit(0);
                            }).catch((e) => {
                                logger.error("❌ Processor 停止失败:", e);
                                process.exit(1);
                            });
                        } else {
                            logger.info("✅ 优雅关闭完成");
                            process.exit(0);
                        }
                    }).catch((e) => {
                        logger.error("❌ 实例协调器停止失败:", e);
                        process.exit(1);
                    });
                });
            } catch (e) {
                logger.error("❌ 优雅关闭失败:", e);
                process.exit(1);
            }
        };

        // 监听关闭信号
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        logger.info("🎉 应用启动完成！");

    } catch (error) {
        logger.error("❌ 应用启动失败:", error);
        process.exit(1);
    }
})();