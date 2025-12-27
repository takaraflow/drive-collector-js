import { kv } from "../services/kv.js";
import { cacheService } from "../utils/CacheService.js";
import logger from "../services/logger.js";

/**
 * 系统设置仓储层
 * 使用 KV 存储作为主存储，符合低频关键数据规则
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

            // 1. 从 KV 获取（主存储）
            const value = await kv.get(cacheKey, "text");
            if (value !== null) {
                cacheService.set(cacheKey, value, 30 * 60 * 1000); // 内存缓存 30 分钟
                return value;
            }

            return defaultValue;
        } catch (e) {
            logger.error(`SettingsRepository.get failed for ${key}:`, e);
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
            logger.warn('SettingsRepository.set called with null/undefined key, ignoring');
            return;
        }

        const cacheKey = this.getSettingsKey(key);
        try {
            // 1. 更新 KV（主存储）
            await kv.set(cacheKey, value);
        } catch (kvError) {
            logger.error(`SettingsRepository.set failed for ${key} (KV):`, kvError);
            throw kvError; // KV是主存储，失败时抛出异常
        }

        // 2. 更新内存缓存
        cacheService.set(cacheKey, value, 30 * 60 * 1000);
    }
}