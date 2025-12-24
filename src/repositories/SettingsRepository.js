import { d1 } from "../services/d1.js";
import { kv } from "../services/kv.js";

/**
 * 系统设置仓储层
 * 负责 'system_settings' 表
 * 使用 KV 存储作为缓存层
 */
export class SettingsRepository {
    static getSettingsKey(key) {
        return `setting:${key}`;
    }

    /**
     * 获取指定键的设置值
     * @param {string} key 
     * @param {string} defaultValue - 如果未找到时的默认值
     * @returns {Promise<string>}
     */
    static async get(key, defaultValue = null) {
        try {
            // 1. 尝试从 KV 获取
            const cached = await kv.get(this.getSettingsKey(key), "text");
            if (cached !== null) return cached;

            // 2. 从 D1 获取
            const row = await d1.fetchOne("SELECT value FROM system_settings WHERE key = ?", [key]);
            const value = row ? row.value : defaultValue;

            // 3. 异步回填到 KV (不阻塞返回)
            if (value !== null) {
                kv.set(this.getSettingsKey(key), value).catch(console.error);
            }

            return value;
        } catch (e) {
            console.error(`SettingsRepository.get failed for ${key}:`, e);
            return defaultValue;
        }
    }

    /**
     * 设置指定键的设置值
     * @param {string} key 
     * @param {string} value 
     * @returns {Promise<void>}
     */
    static async set(key, value) {
        try {
            // 1. 更新 D1
            await d1.run(
                "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                [key, value]
            );

            // 2. 更新 KV
            await kv.set(this.getSettingsKey(key), value);
        } catch (e) {
            console.error(`SettingsRepository.set failed for ${key}:`, e);
        }
    }
}