import http from "http";
import { config } from "./src/config/index.js";
import { client, saveSession, clearSession, resetClientSession, setConnectionStatusCallback } from "./src/services/telegram.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { Dispatcher } from "./src/bot/Dispatcher.js";
import { MessageHandler } from "./src/bot/MessageHandler.js";
import { SettingsRepository } from "./src/repositories/SettingsRepository.js";
import { instanceCoordinator } from "./src/services/InstanceCoordinator.js";

/**
 * --- 🛡️ 全局错误处理 ---
 */
process.on("unhandledRejection", (reason, promise) => {
    console.error("🚨 未捕获的 Promise 拒绝:", reason);
});

process.on("uncaughtException", (err) => {
    console.error("🚨 未捕获的异常:", err);
    // 对于 TIMEOUT 错误，我们通常希望程序继续运行并由 Watchdog 处理
    if (err?.message?.includes("TIMEOUT")) {
        console.warn("⚠️ 忽略 TIMEOUT 导致的进程崩溃风险，等待 Watchdog 恢复...");
    } else {
        // 其他严重错误建议安全退出
        // process.exit(1);
    }
});

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

        // 2. 启动 HTTP 健康检查端口 (用于保活)
        http.createServer((req, res) => {
            res.writeHead(200);
            res.end("Node Service Active");
        }).listen(config.port, '0.0.0.0', () => {
            console.log(`📡 健康检查端口 ${config.port} 已就绪`);
        });

        // 3. 初始化实例协调器（多实例支持）
        await instanceCoordinator.start();

        // --- 🤖 Telegram 客户端多实例协调启动 ---
        let isClientActive = false;

        // 设置连接状态回调，当连接断开时重置 isClientActive
        setConnectionStatusCallback((isConnected) => {
            if (!isConnected && isClientActive) {
                console.log("🔌 Telegram 连接已断开，重置客户端状态");
                isClientActive = false;
            }
        });

        const startTelegramClient = async () => {
            // 尝试获取 Telegram 客户端专属锁 (增加 TTL 到 90s，减少因延迟导致的丢失)
            const hasLock = await instanceCoordinator.acquireLock("telegram_client", 90);
            if (!hasLock) {
                if (isClientActive) {
                    console.warn("🚨 失去 Telegram 锁或无法续租，正在断开连接...");
                    try {
                        // 强制断开，并设置较短的超时防止卡死在 disconnect
                        await Promise.race([
                            client.disconnect(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error("Disconnect Timeout")), 5000))
                        ]);
                    } catch (e) {
                        console.error("⚠️ 断开连接时出错:", e.message);
                    }
                    isClientActive = false;
                }
                return false;
            }

            if (isClientActive) return true; // 已启动且持有锁

            console.log("👑 已获取 Telegram 锁，正在启动客户端...");
            let retryCount = 0;
            const maxRetries = 3;

            while (!isClientActive && retryCount < maxRetries) {
                try {
                    await client.start({ botAuthToken: config.botToken });
                    await saveSession();
                    console.log("🚀 Telegram 客户端已连接");
                    isClientActive = true;
                    return true;
                } catch (error) {
                    if (error.code === 406 && error.errorMessage?.includes('AUTH_KEY_DUPLICATED')) {
                        retryCount++;
                        console.warn(`⚠️ 检测到 AUTH_KEY_DUPLICATED 错误 (尝试 ${retryCount}/${maxRetries})，正在清除旧 Session 并重试...`);
                        if (retryCount < maxRetries) {
                            await clearSession();
                            resetClientSession();
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                    }
                    console.error("❌ 启动 Telegram 客户端失败:", error.message);
                    break;
                }
            }
            return isClientActive;
        };

        // 初始启动尝试
        await startTelegramClient();

        // 定期检查/续租锁
        setInterval(async () => {
            await startTelegramClient();
        }, 30000);

        // 4. 初始化后台任务系统 (恢复历史任务)
        TaskManager.init().then(() => {
            console.log("✅ 历史任务初始化扫描完成");
        }).catch(err => {
            console.error("❌ 任务初始化过程中发生错误:", err);
        });

        // 5. 启动自动缩放监控与任务轮询
        TaskManager.startAutoScaling();
        TaskManager.startPolling();
        console.log("📊 已启动自动缩放监控与分布式任务轮询");

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

        // 4. 注册事件监听器 -> 交给 MessageHandler 处理
        // 初始化 MessageHandler (预加载 Bot ID)
        client.addEventHandler(async (event) => {
            await MessageHandler.handleEvent(event, client);
        });
        
        // 延迟初始化 Bot ID (等待连接建立)
        setTimeout(() => MessageHandler.init(client), 5000);

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