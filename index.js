import http from "http";
import { config } from "./src/config/index.js";
import { client } from "./src/services/telegram.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { Dispatcher } from "./src/bot/Dispatcher.js";

/**
 * --- 🚀 应用程序入口 ---
 */
(async () => {
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
        try {
            await Dispatcher.handle(event);
        } catch (e) {
            console.error("Critical: Unhandled Dispatcher Error:", e);
        }
    });
})();