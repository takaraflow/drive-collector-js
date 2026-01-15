import { Api } from "telegram";
import { Dispatcher } from "./Dispatcher.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { logger } from "../services/logger/index.js";
import { config } from "../config/index.js";
import { streamTransferService } from "../services/StreamTransferService.js";

const log = logger.withModule('MessageHandler');

// 创建带 perf 上下文的 logger 用于性能日志
const logPerf = () => log.withContext({ perf: true });

// 全局消息去重缓存 (防止多实例重复处理)
const processedMessages = new Map();

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
                        await client.invoke(new Api.bots.SetBotCommands({
                            scope: new Api.BotCommandScopePeer({
                                peer: config.ownerId
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
                        log.warn("⚠️ 设置管理员命令失败 (可能是 OWNER_ID 格式不正确):", e.message);
                    }
                }
            } catch (e) {
                // 忽略获取失败，后续处理中会再次尝试
            }
        }
    }

    /**
     * 处理传入的 Telegram 事件
     * @param {object} event - Telegram 事件对象
     * @param {object} client - Telegram Client 实例 (用于获取 Bot ID)
     */
    static async handleEvent(event, client) {
        const start = Date.now();
        
        // 统一提取 message 对象 (兼容 UpdateNewMessage, Message, UpdateShortMessage 等)
        let message = event.message || event;
        
        // 特殊处理 UpdateBotCallbackQuery，它没有 message 属性，数据在 event 本身
        if (event.className === 'UpdateBotCallbackQuery') {
            message = event; // 暂时将 event 视为消息主体进行处理
        }

        // 0. 过滤自己发送的消息 (防止无限循环)
        if (message.out === true) {
            return;
        }

        // 补充：双重检查 senderId
        if (!this.botId && client && client.session?.save()) {
            // 确保客户端已连接
            if (!client.connected) {
                log.warn("⚠️ Telegram 客户端未连接，跳过 Bot ID 检查");
                return;
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
            return;
        }

        // 1. 去重检查：防止多实例部署时的重复处理
        // 仅对有 ID 的消息进行去重 (Message 类型通常有 id，CallbackQuery 有 queryId)
        const msgId = message.id || event.queryId?.toString();
        
        if (msgId) {
            const now = Date.now();

            // 1.1 内存快速过滤
            if (processedMessages.has(msgId)) {
                log.debug("跳过重复消息", { msgId, filter: 'memory' });
                return;
            }
            
            // 1.2 分布式 KV 锁检查 (关键：解决多实例重复响应)
            // 尝试获取该消息的锁，TTL 60秒
            const lockKey = `msg_lock:${msgId}`;
            
            try {
                const lockStart = Date.now();
                const hasLock = await instanceCoordinator.acquireLock(lockKey, 60);
                const lockTime = Date.now() - lockStart;
                
                if (!hasLock) {
                    logPerf().info(`消息 ${msgId} 锁竞争失败 (lock: ${lockTime}ms)`);
                    // 标记为本地已处理，避免后续重复请求 KV
                    processedMessages.set(msgId, now);
                    return;
                }
                logPerf().info(`消息 ${msgId} 获取锁耗时 ${lockTime}ms`);
            } catch (lockError) {
                log.error(`⚠️ 获取消息锁时发生异常, 降级处理继续执行`, lockError);
                // 如果锁服务完全挂了，为了不丢消息，我们可以选择继续处理（但这可能导致重复回复）
                // 这里选择继续执行，毕竟可用性优先
            }

            // 获取锁成功，标记本地并继续
            processedMessages.set(msgId, now);
            
            // 清理超过10分钟的旧消息ID (内存)
            for (const [id, time] of processedMessages.entries()) {
                if (now - time > 10 * 60 * 1000) {
                    processedMessages.delete(id);
                }
            }
        }
        
        try {
            const dispatchStart = Date.now();
            await Dispatcher.handle(event);
            const dispatchTime = Date.now() - dispatchStart;
            const totalTime = Date.now() - start;

            // GramJS UpdateConnectionState 状态常量
            const CONNECTION_STATE = {
                0: 'broken',
                1: 'connected',
                '-1': 'disconnected'
            };

            // 检测 UpdateConnectionState 事件（即使 className 为 unknown）
            const isUpdateConnectionState = event.constructor?.name === 'UpdateConnectionState';

            // 增强消息标识：优先使用 msgId，其次尝试从 event 中提取类型
            let msgIdentifier = msgId || (event.className ? `[${event.className}]` : 'unknown');

            // UpdateConnectionState 特殊处理，不走 unknown 分支
            if (isUpdateConnectionState) {
                const stateNum = typeof event.state === 'number' ? event.state : -999;
                const stateName = CONNECTION_STATE[stateNum] || `stateNum_${stateNum}`;
                msgIdentifier = `[UpdateConnectionState:${stateName}]`;

                log.debug("收到 UpdateConnectionState 事件", {
                    state: stateNum,
                    stateName: stateName
                });
            }

            if (msgIdentifier === 'unknown') {
                // [DEBUG] 打印原始事件的完整结构，用于排查
                log.debug("=== 原始事件调试 ===", {
                    className: event.className,
                    constructorName: event.constructor?.name,
                    keys: Object.keys(event).join(','),
                    stateClassName: event?.state?.className,
                    stateConstructor: event?.state?.constructor?.name,
                    stateKeys: event?.state ? Object.keys(event.state).join(',') : null
                });

                // 安全序列化 Telegram 事件，防止循环引用导致崩溃
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
                // 未知类型事件降级为 debug 日志，减少噪音
                logPerf().debug(`消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
            } else if (isUpdateConnectionState) {
                // UpdateConnectionState 是常规心跳，改为 debug 级别
                logPerf().debug(`消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
            } else {
                // 已知类型事件保留 info 日志
                logPerf().info(`消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
            }
            // 性能监控：如果总耗时超过 500ms，记录警告
            if (totalTime > 500) {
                logPerf().warn(`慢响应警告: 消息处理耗时 ${totalTime}ms，超过阈值 500ms`);
            }
        } catch (e) {
            log.error("Critical: Unhandled Dispatcher Error", e);
        }
    }
}