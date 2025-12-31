import { Api } from "telegram";
import { Dispatcher } from "./Dispatcher.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { logger } from "../services/logger.js";
import { config } from "../config/index.js";

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
                logger.warn("⚠️ Telegram 客户端未连接，跳过初始化");
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
                logger.warn("⚠️ Telegram 客户端未连接，跳过 Bot ID 检查");
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
                logger.debug("跳过重复消息", { msgId, filter: 'memory' });
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
                    logger.info(`[MessageHandler][PERF] 消息 ${msgId} 锁竞争失败 (lock: ${lockTime}ms)`);
                    // 标记为本地已处理，避免后续重复请求 KV
                    processedMessages.set(msgId, now);
                    return;
                }
                logger.info(`[MessageHandler][PERF] 消息 ${msgId} 获取锁耗时 ${lockTime}ms`);
            } catch (lockError) {
                logger.error(`⚠️ 获取消息锁时发生异常, 降级处理继续执行`, lockError);
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
            logger.info(`[MessageHandler][PERF] 消息 ${msgId || 'unknown'} 分发完成，总耗时 ${Date.now() - start}ms (dispatch: ${dispatchTime}ms)`);
        } catch (e) {
            logger.error("Critical: Unhandled Dispatcher Error", e);
        }
    }
}