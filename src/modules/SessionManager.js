import { d1 } from "../services/d1.js";

export class SessionManager {
    // 获取用户当前状态
    static async get(userId) {
        return await d1.fetchOne("SELECT * FROM sessions WHERE user_id = ?", [userId]);
    }

    // 开启新会话 (覆盖旧的)
    static async start(userId, step, data = {}) {
        const now = Date.now();
        await d1.run(`
            INSERT INTO sessions (user_id, current_step, temp_data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
            current_step = excluded.current_step,
            temp_data = excluded.temp_data,
            updated_at = excluded.updated_at
        `, [userId, step, JSON.stringify(data), now]);
    }

    // 更新当前会话数据
    static async update(userId, step, newData = {}) {
        const current = await this.get(userId);
        if (!current) return;
        
        const mergedData = { ...JSON.parse(current.temp_data || '{}'), ...newData };
        await d1.run(
            "UPDATE sessions SET current_step = ?, temp_data = ?, updated_at = ? WHERE user_id = ?",
            [step, JSON.stringify(mergedData), Date.now(), userId]
        );
        return mergedData;
    }

    // 结束会话
    static async clear(userId) {
        await d1.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    }
}