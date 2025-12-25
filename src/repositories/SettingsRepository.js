import { d1 } from "../services/d1.js";
import { kv } from "../services/kv.js";
import { cacheService } from "../utils/CacheService.js";

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
        const cacheKey = this.getSettingsKey(key);
        try {
            // 0. 尝试从内存缓存获取
            const memoryCached = cacheService.get(cacheKey);
            if (memoryCached !== null) return memoryCached;

            // 1. 尝试从 KV 获取
            const cached = await kv.get(cacheKey, "text");
            if (cached !== null) {
                cacheService.set(cacheKey, cached, 30 * 60 * 1000); // 内存缓存 30 分钟
                return cached;
            }

            // 2. 从 D1 获取
            const row = await d1.fetchOne("SELECT value FROM system_settings WHERE key = ?", [key]);
            const value = row ? row.value : defaultValue;

            // 3. 异步回填到 KV 和内存 (不阻塞返回)
            if (value !== null) {
                kv.set(cacheKey, value).catch(console.error);
                cacheService.set(cacheKey, value, 30 * 60 * 1000);
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
        // 处理null key的情况
        if (key == null) {
            console.warn('SettingsRepository.set called with null/undefined key, ignoring');
            return;
        }

        const cacheKey = this.getSettingsKey(key);
        try {
            // 1. 更新 D1
            await d1.run(
                "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                [key, value]
            );
        } catch (dbError) {
            console.error(`SettingsRepository.set failed for ${key} (D1):`, dbError);
            throw dbError; // D1是主存储，失败时抛出异常
        }

        // 2. 更新内存缓存
        cacheService.set(cacheKey, value, 30 * 60 * 1000);

        // 3. 尝试更新 KV（失败不影响主流程）
        try {
            await kv.set(cacheKey, value);
        } catch (kvError) {
            console.warn(`⚠️ KV缓存更新失败，继续使用D1存储: ${kvError.message}`);
        }
    }
}