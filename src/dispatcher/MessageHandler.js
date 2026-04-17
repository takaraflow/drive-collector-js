import { Api } from "telegram";
import { Dispatcher } from "./Dispatcher.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { logger } from "../services/logger/index.js";
import { config } from "../config/index.js";
import { streamTransferService } from "../services/StreamTransferService.js";

const log = logger.withModule('MessageHandler');

// 创建带 perf 上下文的 logger 用于性能日志
const logPerf = () => log.withContext({ perf: true });

// LRU 缓存实现 - 带容量限制和 TTL
class LRUCache {
    constructor(maxSize = 10000, ttlMs = 10 * 60 * 1000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.cache = new Map();
        this.cleanupCounter = 0;
        this.cleanupInterval = 100; // Cleanup every 100 operations
    }

    set(key, value) {
        const now = Date.now();
        
        // 如果 key 已存在，删除旧条目（用于更新位置）
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        
        // 如果缓存已满，删除最旧的条目
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        
        this.cache.set(key, { value, timestamp: now });
        
        // Periodic cleanup
        this.cleanupCounter++;
        if (this.cleanupCounter >= this.cleanupInterval) {
            this.cleanup();
            this.cleanupCounter = 0;
        }
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        
        const now = Date.now();
        if (now - entry.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return null;
        }
        
        // 访问后更新位置（移动到 Map 末尾）
        this.cache.delete(key);
        this.cache.set(key, entry);
        
        return entry.value;
    }

    has(key) {
        return this.get(key) !== null;
    }

    cleanup() {
        const now = Date.now();
        const keysToDelete = [];
        
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.ttlMs) {
                keysToDelete.push(key);
            }
        }
        
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }
    }

    get size() {
        return this.cache.size;
    }
}

// 全局消息去重缓存 (防止多实例重复处理)
// 使用 LRU 缓存，限制最大容量为 10000 条，TTL 为 10 分钟
const processedMessages = new LRUCache(10000, 10 * 60 * 1000);

/**
 * 消息处理器：负责消息过滤、去重和分发
 */
export class MessageHandler {
    static botId = null;

    /**
     * 设置自定义路由 (用于内部服务通信)
     * @param {object} app - Express/Hono app 实例 (如果使用)
     * 目前这里主要是为了对接 HTTP 请求，如果有单独的 HTTP 服务器
     * 如果没有，这里暂时作为逻辑占位，实际路由可能在 index.js 或 worker.js 中
     */
    static setupRoutes(app) {
        // 获取流传输进度的路由
        // GET /api/v2/stream/:taskId/progress
        // 这里只是示例，实际需要看项目使用的 Web 框架
        // 假设这里我们通过某种方式暴露了 API
    }

    /**
     * 处理内部 API 请求 (模拟路由分发)
     * 实际项目中可能通过 Worker 的 fetch 事件处理
     */
    static async handleApiRequest(request) {
        try {
            const url = new URL(request.url);
            const taskId = url.pathname.match(/\/api\/v2\/stream\/([^\/]+)/)?.[1];
            
            if (!taskId) {
                return null; // Not handled
            }

            // 校验 Secret
            const secret = request.headers.get('x-instance-secret');
            if (secret !== config.streamForwarding.secret) {
                return new Response('Unauthorized', { status: 401 });
            }

            // GET /api/v2/stream/:taskId/progress
            const progressMatch = url.pathname.match(/\/api\/v2\/stream\/([^\/]+)\/progress$/);
            if (progressMatch && request.method === 'GET') {
                const progress = streamTransferService.getTaskProgress(taskId);
                return new Response(JSON.stringify({ lastChunkIndex: progress }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // GET /api/v2/stream/:taskId/full-progress
            const fullProgressMatch = url.pathname.match(/\/api\/v2\/stream\/([^\/]+)\/full-progress$/);
            if (fullProgressMatch && request.method === 'GET') {
                const fullProgress = await streamTransferService.getTaskFullProgress(taskId);
                return new Response(JSON.stringify(fullProgress), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // POST /api/v2/stream/:taskId/resume
            const resumeMatch = url.pathname.match(/\/api\/v2\/stream\/([^\/]+)\/resume$/);
            if (resumeMatch && request.method === 'POST') {
                let body;
                try {
                    body = await request.json();
                } catch (error) {
                    log.error('Failed to parse request JSON', {
                        url: request.url,
                        method: request.method,
                        error: error.message
                    });
                    return new Response('Invalid JSON', { status: 400 });
                }
                const result = await streamTransferService.resumeTask(taskId, body);
                return new Response(JSON.stringify(result), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // DELETE /api/v2/stream/:taskId/reset
            const resetMatch = url.pathname.match(/\/api\/v2\/stream\/([^\/]+)\/reset$/);
            if (resetMatch && request.method === 'DELETE') {
                const result = await streamTransferService.resetTask(taskId);
                return new Response(JSON.stringify(result), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

        } catch (e) {
            log.error('API Request Error:', e);
            return new Response('Internal Server Error', { status: 500 });
        }
        return null; // Not handled
}

    /**
     * 初始化 Bot ID
     * @param {object} client - Telegram Client 实例
     */

    static async init(client) {
        if (!this.botId && client.session?.save()) {
            // 确保客户端已连接
            if (!client.connected) {
                log.warn("⚠️ Telegram 客户端未连接，跳过初始化");
                return;
            }
            try {
                const me = await client.getMe();
                if (me) this.botId = me.id.toString();

                // 设置普通用户命令
                const commonCommands = [
                    new Api.BotCommand({ command: 'start', description: '🚀 启动机器人' }),
                    new Api.BotCommand({ command: 'drive', description: '🔑 绑定或管理网盘' }),
                    new Api.BotCommand({ command: 'files', description: '📁 浏览已转存文件' }),
                    new Api.BotCommand({ command: 'status', description: '📊 查看系统状态' }),
                    new Api.BotCommand({ command: 'remote_folder', description: '📂 上传路径设置' }),
                    new Api.BotCommand({ command: 'help', description: '📖 显示帮助菜单' }),
                ];

                // 1. 设置默认菜单（所有用户可见）
                await client.invoke(new Api.bots.SetBotCommands({
                    scope: new Api.BotCommandScopeDefault(),
                    langCode: '',
                    commands: commonCommands
                }));

                // 2. 为管理员设置专属菜单（包含普通命令 + 管理员指令，排在下方）
                if (config.ownerId) {
                    try {
                        // 尝试解析 ownerId 为 InputPeer，确保 BotCommandScopePeer 接收到有效的 peer 对象
                        const ownerPeer = await client.getInputEntity(config.ownerId);
                        
                        await client.invoke(new Api.bots.SetBotCommands({
                            scope: new Api.BotCommandScopePeer({
                                peer: ownerPeer
                            }),
                            langCode: '',
                            commands: [
                                ...commonCommands,
                                new Api.BotCommand({ command: 'diagnosis', description: '🩺 系统诊断' }),
                                new Api.BotCommand({ command: 'open_service', description: '🔓 开启服务' }),
                                new Api.BotCommand({ command: 'close_service', description: '🔒 关闭服务' }),
                            ]
                        }));
                    } catch (e) {
                        log.warn("⚠️ 设置管理员命令失败 (可能是 OWNER_ID 格式不正确或用户未交互):", e.message);
                    }
                }
            } catch (e) {
                // 忽略获取失败，后续处理中会再次尝试
            }
        }
    }


    /**
     * 从事件中提取消息对象
     * @param {object} event
     */
    static _extractMessage(event) {
        let message = event.message || event;
        if (event.className === 'UpdateBotCallbackQuery') {
            message = event;
        }
        return message;
    }

    /**
     * 验证并初始化 Bot ID，检查发送者是否为自己
     * @param {object} message
     * @param {object} client
     */
    static async _verifyBotAndSender(message, client) {
        if (!this.botId && client && client.session?.save()) {
            if (!client.connected) {
                log.warn("⚠️ Telegram 客户端未连接，跳过 Bot ID 检查");
                return false;
            }
            try {
                const me = await client.getMe();
                if (me) this.botId = me.id.toString();
            } catch (error) {
                log.warn('Failed to get Bot ID during message handling', {
                    error: error.message,
                    willContinue: true
                });
            }
        }
        
        if (this.botId && message.senderId?.toString() === this.botId) {
            return false;
        }
        return true;
    }

    /**
     * 获取消息锁，用于去重
     * @param {string} msgId
     */
    static async _acquireMessageLock(msgId) {
        if (!msgId) return true;
        
        const now = Date.now();

        if (processedMessages.has(msgId)) {
            log.debug("跳过重复消息", { msgId, filter: 'memory' });
            return false;
        }

        const lockKey = `msg_lock:${msgId}`;
        try {
            const lockStart = Date.now();
            const hasLock = await instanceCoordinator.acquireLock(lockKey, 60);
            const lockTime = Date.now() - lockStart;
            
            if (!hasLock) {
                logPerf().info(`消息 ${msgId} 锁竞争失败 (lock: ${lockTime}ms)`);
                processedMessages.set(msgId, now);
                return false;
            }
            logPerf().info(`消息 ${msgId} 获取锁耗时 ${lockTime}ms`);
        } catch (lockError) {
            log.error(`⚠️ 获取消息锁时发生异常, 降级处理继续执行`, lockError);
        }

        processedMessages.set(msgId, now);

        if (processedMessages.size % 100 === 0) {
            processedMessages.cleanup();
        }
        
        return true;
    }

    /**
     * 记录分发结果
     * @param {object} event
     * @param {string} msgId
     * @param {number} totalTime
     * @param {number} dispatchTime
     */
    static _logDispatchResult(event, msgId, totalTime, dispatchTime) {
        const CONNECTION_STATE = {
            0: 'broken',
            1: 'connected',
            '-1': 'disconnected'
        };

        const isUpdateConnectionState = event.constructor?.name === 'UpdateConnectionState';
        let msgIdentifier = msgId || (event.className ? `[${event.className}]` : 'unknown');

        if (isUpdateConnectionState) {
            const stateNum = typeof event.state === 'number' ? event.state : -999;
            const stateName = CONNECTION_STATE[stateNum] || `stateNum_${stateNum}`;
            msgIdentifier = `[UpdateConnectionState:${stateName}]`;
        }

        if (msgIdentifier === 'unknown') {
            log.debug("=== 原始事件调试 ===", {
                className: event.className,
                constructorName: event.constructor?.name,
                keys: Object.keys(event).join(','),
                stateClassName: event?.state?.className,
                stateConstructor: event?.state?.constructor?.name,
                stateKeys: event?.state ? Object.keys(event.state).join(',') : null
            });

            const safeSerializeEvent = (ev) => {
                try {
                    if (!ev) return '{}';
                    const safeEvent = {
                        className: ev?.className || 'unknown',
                        id: (ev?.id || ev?.queryId || ev?.message?.id || 'no-id')?.toString?.() || 'no-id',
                        text: (ev?.message?.message || '').substring(0, 100),
                        timestamp: ev?.date,
                        mediaType: ev?.message?.media?.className || 'none'
                    };
                    return JSON.stringify(safeEvent, (k, v) => typeof v === 'bigint' ? v.toString() : v).substring(0, 500);
                } catch (err) {
                    return '[SERIALIZE_ERROR]';
                }
            };

            log.debug("收到未知类型事件，详细内容:", {
                className: event.className,
                constructorName: event.constructor?.name,
                keys: Object.keys(event),
                event: safeSerializeEvent(event)
            });
            logPerf().debug(`消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
        } else if (isUpdateConnectionState) {
            logPerf().debug(`消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
        } else {
            logPerf().info(`消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
        }

        if (totalTime > 500) {
            logPerf().warn(`慢响应警告: 消息处理耗时 ${totalTime}ms，超过阈值 500ms`);
        }
    }

    /**
     * 处理传入的 Telegram 事件
     * @param {object} event - Telegram 事件对象
     * @param {object} client - Telegram Client 实例 (用于获取 Bot ID)
     */
    static async handleEvent(event, client) {
        const start = Date.now();

        const message = this._extractMessage(event);

        if (message.out === true) {
            return;
        }

        const isValidSender = await this._verifyBotAndSender(message, client);
        if (!isValidSender) {
            return;
        }

        const msgId = message.id || event.queryId?.toString();
        const canProcess = await this._acquireMessageLock(msgId);

        if (!canProcess) {
            return;
        }

        try {
            const dispatchStart = Date.now();
            await Dispatcher.handle(event);
            const dispatchTime = Date.now() - dispatchStart;
            const totalTime = Date.now() - start;

            this._logDispatchResult(event, msgId, totalTime, dispatchTime);
        } catch (e) {
            log.error("Critical: Unhandled Dispatcher Error", e);
        }
    }

}