import { gracefulShutdown } from "../services/GracefulShutdown.js";

let httpServer = null;

export function setHttpServer(server) {
    httpServer = server;
}

export function getHttpServer() {
    return httpServer;
}

async function closeHttpServer() {
    if (!httpServer) return;
    return new Promise(resolve => {
        httpServer.close(() => {
            console.log('✅ HTTP Server 已关闭');
            resolve();
        });
    });
}

export async function registerShutdownHooks() {
    const { instanceCoordinator } = await import("../services/InstanceCoordinator.js");
    const { cache } = await import("../services/CacheService.js");
    const { stopWatchdog, client } = await import("../services/telegram.js");
    const { TaskRepository } = await import("../repositories/TaskRepository.js");

    // 1. 停止接受新请求 (priority: 10)
    gracefulShutdown.register(async () => {
        await closeHttpServer();
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

export async function buildWebhookServer(config, handler, log) {
    const http2Config = config.http2 || {};
    let server;

    if (http2Config.enabled) {
        const http2 = await import("http2");
        if (http2Config.plain) {
            server = http2.createServer({}, handler);
        } else {
            if (!http2Config.keyPath || !http2Config.certPath) {
                log.error("?? HTTP/2 已启用，但未配置 TLS 证书路径 (HTTP2_TLS_KEY_PATH/HTTP2_TLS_CERT_PATH)");
                throw new Error("http2-tls-missing");
            }
            const { readFileSync } = await import("fs");
            server = http2.createSecureServer({
                key: readFileSync(http2Config.keyPath),
                cert: readFileSync(http2Config.certPath),
                allowHTTP1: http2Config.allowHttp1 !== false
            }, handler);
        }
    } else {
        const http = await import("http");
        server = http.createServer(handler);
    }

    setHttpServer(server);
    await new Promise(resolve => server.listen(config.port, resolve));
    log.info(`?? Webhook Server 运行在端口: ${config.port}`);
    return server;
}
