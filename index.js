import http from "http";
import { config } from "./src/config/index.js";
import { client, saveSession, clearSession, resetClientSession } from "./src/services/telegram.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { Dispatcher } from "./src/bot/Dispatcher.js";
import { SettingsRepository } from "./src/repositories/SettingsRepository.js";
import { instanceCoordinator } from "./src/services/InstanceCoordinator.js";

// 全局消息去重缓存 (防止多实例重复处理)
const processedMessages = new Map();

/**
 * --- 🚀 应用程序入口 ---
 */
(async () => {
    try {
        console.log("🔄 正在启动应用...");

        // --- 🛡️ 启动退避机制 (Startup Backoff) ---
        const lastStartup = await SettingsRepository.get("last_startup_time", "0");
        const now = Date.now();
        const diff = now - parseInt(lastStartup);
        
        // 如果两次启动间隔小于 60 秒，触发退避
        if (diff < 60 * 1000) {
            const crashCount = parseInt(await SettingsRepository.get("recent_crash_count", "0")) + 1;
            await SettingsRepository.set("recent_crash_count", crashCount.toString());
            
            // 指数级增加退避时间：基础 10s * crashCount，最大 5 分钟
            const backoffSeconds = Math.min(10 * crashCount + Math.floor((60 * 1000 - diff) / 1000), 300);
            
            console.warn(`⚠️ 检测到频繁重启 (次数: ${crashCount}, 间隔: ${Math.floor(diff/1000)}s)，启动退避：休眠 ${backoffSeconds}s...`);
            await new Promise(r => setTimeout(r, backoffSeconds * 1000));
        } else {
            // 如果启动间隔正常，重置崩溃计数
            await SettingsRepository.set("recent_crash_count", "0");
        }
        await SettingsRepository.set("last_startup_time", Date.now().toString());

        // 1. 启动 Telegram 客户端（带重试机制处理 AUTH_KEY_DUPLICATED）
        let clientStarted = false;
        let retryCount = 0;
        const maxRetries = 3;

        while (!clientStarted && retryCount < maxRetries) {
            try {
                await client.start({ botAuthToken: config.botToken });
                await saveSession(); // 登录成功后保存 Session
                console.log("🚀 Telegram 客户端已连接");
                clientStarted = true;
            } catch (error) {
                if (error.code === 406 && error.errorMessage?.includes('AUTH_KEY_DUPLICATED')) {
                    retryCount++;
                    console.warn(`⚠️ 检测到 AUTH_KEY_DUPLICATED 错误 (尝试 ${retryCount}/${maxRetries})，正在清除旧 Session 并重试...`);

                    if (retryCount < maxRetries) {
                        await clearSession();
                        resetClientSession(); // 关键：重置内存中的 Session
                        // 等待一小段时间让服务器释放旧连接
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                }

                // 如果不是 AUTH_KEY_DUPLICATED 错误或者重试次数用完，直接抛出错误
                throw error;
            }
        }

        // 2. 启动 HTTP 健康检查端口 (用于保活)
        http.createServer((req, res) => {
            res.writeHead(200);
            res.end("Node Service Active");
        }).listen(config.port, '0.0.0.0', () => {
            console.log(`📡 健康检查端口 ${config.port} 已就绪`);
        });

        // 3. 初始化实例协调器（多实例支持）
        await instanceCoordinator.start();

        // 4. 初始化后台任务系统 (恢复历史任务)
        TaskManager.init().then(() => {
            console.log("✅ 历史任务初始化扫描完成");
        }).catch(err => {
            console.error("❌ 任务初始化过程中发生错误:", err);
        });

        // 5. 启动自动缩放监控
        TaskManager.startAutoScaling();
        console.log("📊 已启动自动缩放监控，将动态调整并发参数");

        // 5. 启动后台预热：扫描有绑定网盘的用户并预热文件列表
        (async () => {
            try {
                const { DriveRepository } = await import("./src/repositories/DriveRepository.js");
                const { CloudTool } = await import("./src/services/rclone.js");
                const activeDrives = await DriveRepository.findAll();
                if (activeDrives.length > 0) {
                    console.log(`🔥 正在预热 ${activeDrives.length} 个用户的云端文件列表...`);
                    // 使用并行但受限的方式预热，避免启动时瞬间 Rclone 爆炸
                    for (const drive of activeDrives) {
                        CloudTool.listRemoteFiles(drive.user_id, true).catch(() => {});
                        await new Promise(r => setTimeout(r, 2000)); // 每 2s 启动一个预热
                    }
                }
            } catch (e) {
                console.error("❌ 预热失败:", e.message);
            }
        })();

        // 4. 注册事件监听器 -> 交给分发器处理
        client.addEventHandler(async (event) => {
            // 多实例分片处理：防止重复消息 (通过环境变量控制)
            const msgId = event.message?.id;
            if (msgId && process.env.INSTANCE_COUNT && process.env.INSTANCE_ID) {
                const count = parseInt(process.env.INSTANCE_COUNT);
                const id = parseInt(process.env.INSTANCE_ID);
                if (msgId % count !== (id - 1) % count) {
                    return; // 跳过不属于此实例的消息
                }
            }
            
            // 去重检查：防止多实例部署时的重复处理
            if (msgId) {
                const now = Date.now();
                if (processedMessages.has(msgId)) {
                    console.log(`Skipping duplicate message ${msgId}`);
                    return;
                }
                processedMessages.set(msgId, now);
                
                // 清理超过10分钟的旧消息ID
                for (const [id, time] of processedMessages.entries()) {
                    if (now - time > 10 * 60 * 1000) {
                        processedMessages.delete(id);
                    }
                }
            }
            
            try {
                await Dispatcher.handle(event);
            } catch (e) {
                console.error("Critical: Unhandled Dispatcher Error:", e);
            }
        });

        // 6. 设置优雅关闭处理
        const gracefulShutdown = async (signal) => {
            console.log(`\n📴 收到 ${signal} 信号，正在优雅关闭...`);

            try {
                // 停止实例协调器
                await instanceCoordinator.stop();

                // 停止自动缩放监控
                TaskManager.stopAutoScaling();

                console.log("✅ 优雅关闭完成");
                process.exit(0);
            } catch (e) {
                console.error("❌ 优雅关闭失败:", e);
                process.exit(1);
            }
        };

        // 监听关闭信号
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        console.log("🎉 应用启动完成！");

    } catch (error) {
        console.error("❌ 应用启动失败:", error);
        process.exit(1);
    }
})();