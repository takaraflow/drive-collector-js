import { kv } from "../services/kv.js";

export class SessionManager {
    static getSessionKey(userId) {
        return `session:${userId}`;
    }

    // 获取用户当前状态
    static async get(userId) {
        // 使用 30 秒内存缓存，减少同一用户交互时的 KV 调用
        return await kv.get(this.getSessionKey(userId), "json", { cacheTtl: 30000 });
    }

    // 开启新会话 (覆盖旧的)
    static async start(userId, step, data = {}) {
        const session = {
            user_id: userId,
            current_step: step,
            temp_data: JSON.stringify(data),
            updated_at: Date.now()
        };
        // 会话默认保留 24 小时 (86400 秒)
        // 写入时同时更新 L1 缓存
        await kv.set(this.getSessionKey(userId), session, 86400);
    }

    // 更新当前会话数据
    static async update(userId, step, newData = {}) {
        const current = await this.get(userId);
        if (!current) return;
        
        const mergedData = { ...JSON.parse(current.temp_data || '{}'), ...newData };
        const updatedSession = {
            ...current,
            current_step: step,
            temp_data: JSON.stringify(mergedData),
            updated_at: Date.now()
        };
        
        await kv.set(this.getSessionKey(userId), updatedSession, 86400);
        return mergedData;
    }

    // 结束会话
    static async clear(userId) {
        await kv.delete(this.getSessionKey(userId));
    }
}