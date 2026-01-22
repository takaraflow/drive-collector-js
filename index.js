import { gracefulShutdown } from "./src/services/GracefulShutdown.js";
import { AppInitializer } from "./src/bootstrap/AppInitializer.js";
import { HttpServer } from "./src/http/HttpServer.js";
import { getConfig } from "./src/config/index.js";

/**
 * 主应用入口
 */
async function main() {
    const appInitializer = new AppInitializer();
    global.appInitializer = appInitializer; // 注册到全局供健康检查使用
    
    try {
        // 初始化应用
        await appInitializer.initialize();
        
        // 获取配置
        const config = getConfig();
        
        // 启动HTTP服务器
        const httpServer = new HttpServer(config);
        await httpServer.start();
        
        // 启动业务模块
        await appInitializer.start();
        
    } catch (error) {
        console.error("💀 引导程序失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('main-failed', error);
    }
}

// 导出Webhook处理函数供外部使用
export { handleWebhook, setAppReadyState } from "./src/webhook/WebhookRouter.js";
export { main };

// 执行主函数
if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index'))) {
    main().catch(error => {
        console.error("💀 引导程序失败:", error);
        gracefulShutdown.exitCode = 1;
        gracefulShutdown.shutdown('main-failed', error);
    });
}