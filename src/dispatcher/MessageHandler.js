import { Api } from "telegram";
import { Dispatcher } from "./Dispatcher.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { logger } from "../services/logger.js";
import { config } from "../config/index.js";

const log = logger.withModule ? logger.withModule('MessageHandler') : logger;

// 全局消息去重缓存 (防止多实例重复处理)
const processedMessages = new Map();

/**
 * 消息处理器：负责消息过滤、去重和分发
 */
export class MessageHandler {
    static botId = null;

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
                    new Api.BotCommand({ command: 'drive', description: '🔑 绑定或管理网盘' }),
                    new Api.BotCommand({ command: 'files', description: '📁 浏览已转存文件' }),
                    new Api.BotCommand({ command: 'status', description: '📊 查看系统状态' }),
                    new Api.BotCommand({ command: 'help', description: '📖 显示帮助菜单' }),
                ];

                await client.invoke(new Api.bots.SetBotCommands({
                    scope: new Api.BotCommandScopeDefault(),
                    langCode: '',
                    commands: commonCommands
                }));

                // 为管理员设置专属命令
                if (config.ownerId) {
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
            } catch (e) {}
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
                    log.info(`[PERF] 消息 ${msgId} 锁竞争失败 (lock: ${lockTime}ms)`);
                    // 标记为本地已处理，避免后续重复请求 KV
                    processedMessages.set(msgId, now);
                    return;
                }
                log.info(`[PERF] 消息 ${msgId} 获取锁耗时 ${lockTime}ms`);
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
                log.debug(`[PERF] 消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
            } else {
                // 已知类型事件保留 info 日志
                log.info(`[PERF] 消息 ${msgIdentifier} 分发完成，总耗时 ${totalTime}ms (dispatch: ${dispatchTime}ms)`);
            }
            // 性能监控：如果总耗时超过 500ms，记录警告
            if (totalTime > 500) {
                log.warn(`[PERF] 慢响应警告: 消息处理耗时 ${totalTime}ms，超过阈值 500ms`);
            }
        } catch (e) {
            log.error("Critical: Unhandled Dispatcher Error", e);
        }
    }
}
