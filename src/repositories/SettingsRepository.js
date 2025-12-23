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
}