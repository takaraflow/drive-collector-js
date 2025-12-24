import { d1 } from "../services/d1.js";

/**
 * 系统设置仓储层
 * 负责 'system_settings' 表
 */
export class SettingsRepository {
    /**
     * 获取指定键的设置值
     * @param {string} key 
     * @param {string} defaultValue - 如果未找到时的默认值
     * @returns {Promise<string>}
     */
    static async get(key, defaultValue = null) {
        try {
            const row = await d1.fetchOne("SELECT value FROM system_settings WHERE key = ?", [key]);
            return row ? row.value : defaultValue;
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
            await d1.run(
                "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                [key, value]
            );
        } catch (e) {
            console.error(`SettingsRepository.set failed for ${key}:`, e);
        }
    }
}