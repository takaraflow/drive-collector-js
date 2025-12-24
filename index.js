import http from "http";
import { config } from "./src/config/index.js";
import { client } from "./src/services/telegram.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { Dispatcher } from "./src/bot/Dispatcher.js";

// 全局消息去重缓存 (防止多实例重复处理)
const processedMessages = new Map();

/**
 * --- 🚀 应用程序入口 ---
 */
(async () => {
    try {
        console.log("🔄 正在启动应用...");
        // 1. 启动 Telegram 客户端
        await client.start({ botAuthToken: config.botToken });
        console.log("🚀 Telegram 客户端已连接");

        // 2. 启动 HTTP 健康检查端口 (用于保活)
        http.createServer((req, res) => {
            res.writeHead(200);
            res.end("Node Service Active");
        }).listen(config.port, '0.0.0.0', () => {
            console.log(`📡 健康检查端口 ${config.port} 已就绪`);
        });

        // 3. 初始化后台任务系统 (恢复历史任务)
        TaskManager.init().then(() => {
            console.log("✅ 历史任务初始化扫描完成");
        }).catch(err => {
            console.error("❌ 任务初始化过程中发生错误:", err);
        });

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
    } catch (error) {
        console.error("❌ 应用启动失败:", error);
        process.exit(1);
    }
})();