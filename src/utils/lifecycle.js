import { gracefulShutdown } from "../services/GracefulShutdown.js";
import { logger } from "../services/logger/index.js";
import { stopMemoryMonitor } from "../utils/memoryMonitor.js";

const log = logger.withModule('Lifecycle');

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
            log.info('✅ HTTP Server 已关闭');
            resolve();
        });
    });
}

export async function registerShutdownHooks() {
    const { instanceCoordinator } = await import("../services/InstanceCoordinator.js");
    const { cache } = await import("../services/CacheService.js");
    const { stopWatchdog, client } = await import("../services/telegram.js");
    const { TaskRepository } = await import("../repositories/TaskRepository.js");
    const { TaskManager } = await import("../processor/TaskManager.js");
    const { flushLogBuffer } = await import("../services/logger/index.js");
    const mediaGroupBufferModule = await import("../services/MediaGroupBuffer.js");
    const mediaGroupBuffer = mediaGroupBufferModule.default;
    const { distributedLock } = await import("../services/DistributedLock.js");

    // 注册实例活跃任务计数器（用于多实例统计/监控）
    if (instanceCoordinator && typeof instanceCoordinator.registerActiveTaskCounter === 'function') {
        instanceCoordinator.registerActiveTaskCounter(() => {
            return TaskManager.getProcessingCount() + TaskManager.getWaitingCount();
        });
    }

    // 注册任务计数器（用于任务排空）
    gracefulShutdown.registerTaskCounter(() => {
        return TaskManager.getProcessingCount() + TaskManager.getWaitingCount();
    });

    // -1. 停止内存监控 (priority: 1)
    gracefulShutdown.register(async () => {
        stopMemoryMonitor();
    }, 1, 'memory-monitor');

    // 0. 在关闭开始前先刷新一次日志，确保关闭前的错误日志被保存 (priority: 5)
    gracefulShutdown.register(async () => {
        log.info('🔄 正在刷新日志缓冲区...');
        await flushLogBuffer();
        log.info('✅ 日志缓冲区已刷新');
    }, 5, 'logger-flush-before');

    // 1. 停止接受新请求 (priority: 10)
    gracefulShutdown.register(async () => {
        await closeHttpServer();
    }, 10, 'http-server');

    // 2. 停止实例协调器 (priority: 20)
    gracefulShutdown.register(async () => {
        await instanceCoordinator.stop();
        log.info('✅ InstanceCoordinator 已停止');
    }, 20, 'instance-coordinator');

    // 3. 停止 Telegram 看门狗和客户端 (priority: 30)
    gracefulShutdown.register(async () => {
        stopWatchdog();
        if (client && client.connected) {
            await client.disconnect();
            log.info('✅ Telegram 客户端已断开');
        }
    }, 30, 'telegram-client');

    // 4. 持久化 MediaGroupBuffer (priority: 35)
    gracefulShutdown.register(async () => {
        try {
            await mediaGroupBuffer.persist();
            log.info('✅ MediaGroupBuffer 已持久化');
        } catch (error) {
            log.error('❌ MediaGroupBuffer 持久化失败:', error);
        }
    }, 35, 'media-group-buffer-persist');

    // 5. 刷新待处理的任务更新 (priority: 40)
    gracefulShutdown.register(async () => {
        await TaskRepository.flushUpdates();
        log.info('✅ TaskRepository 待更新任务已刷新');
    }, 40, 'task-repository');

    // 6. 停止分布式锁服务 (priority: 45)
    gracefulShutdown.register(async () => {
        if (distributedLock) {
            await distributedLock.shutdown();
            log.info('✅ DistributedLock 已停止');
        }
    }, 45, 'distributed-lock');

    // 7. 停止 MediaGroupBuffer 清理任务 (priority: 48)
    gracefulShutdown.register(async () => {
        if (mediaGroupBuffer && typeof mediaGroupBuffer.stopCleanup === 'function') {
            mediaGroupBuffer.stopCleanup();
            log.info('✅ MediaGroupBuffer 清理任务已停止');
        }
    }, 48, 'media-group-buffer-cleanup');

    // 8. 断开 Cache 连接 (priority: 50)
    gracefulShutdown.register(async () => {
        await cache.destroy();
        log.info('✅ Cache 服务已断开');
    }, 50, 'cache-service');

    // 9. 停止 Tunnel 服务 (priority: 55)
    gracefulShutdown.register(async () => {
        const { tunnelService } = await import("../services/TunnelService.js");
        tunnelService.stop();
        log.info('✅ Tunnel 服务已停止');
    }, 55, 'tunnel-service');

    // 10. 在关闭完成后再次刷新日志，确保关闭过程中的日志也被保存 (priority: 60)
    gracefulShutdown.register(async () => {
        log.info('🔄 正在刷新关闭过程中的日志...');
        await flushLogBuffer();
        // 给日志发送一些时间完成
        await new Promise(resolve => setTimeout(resolve, 1000));
        log.info('✅ 所有日志已刷新完成');
    }, 60, 'logger-flush-after');
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
