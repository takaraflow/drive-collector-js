import { Dispatcher } from "./Dispatcher.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";

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
            try {
                const me = await client.getMe();
                if (me) this.botId = me.id.toString();
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
        // 基础事件记录
        if (event.className === 'UpdateNewMessage' || event.className === 'UpdateBotCallbackQuery') {
            // console.log(`📩 收到新事件: ${event.className}`);
        }

        // 0. 过滤自己发送的消息 (防止无限循环)
        if (event.message?.out) {
            // GramJS 的 out 属性标识是否为自己发送的消息
            return;
        }

        // 补充：双重检查 senderId (针对某些特殊情况)
        if (!this.botId && client && client.session?.save()) {
            // 尝试懒加载 Bot ID
            try {
                const me = await client.getMe();
                if (me) this.botId = me.id.toString();
            } catch (e) {}
        }
        
        if (this.botId && event.message?.senderId?.toString() === this.botId) {
            return;
        }

        // 1. 去重检查：防止多实例部署时的重复处理
        // 升级为：内存 + KV 双层去重
        const msgId = event.message?.id;
        if (msgId) {
            const now = Date.now();

            // 1.1 内存快速过滤
            if (processedMessages.has(msgId)) {
                console.log(`♻️ [Memory] 跳过重复消息 ${msgId}`);
                return;
            }
            
            // 1.2 分布式 KV 锁检查 (关键：解决多实例重复响应)
            // 尝试获取该消息的锁，TTL 60秒
            const lockKey = `msg_lock:${msgId}`;
            const hasLock = await instanceCoordinator.acquireLock(lockKey, 60);
            
            if (!hasLock) {
                console.log(`♻️ [Distributed] 跳过重复消息 ${msgId} (其他实例正在处理)`);
                // 标记为本地已处理，避免后续重复请求 KV
                processedMessages.set(msgId, now);
                return;
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
            await Dispatcher.handle(event);
        } catch (e) {
            console.error("Critical: Unhandled Dispatcher Error:", e);
        }
    }
}