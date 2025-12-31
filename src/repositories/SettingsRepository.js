import { cache } from "../services/CacheService.js";
import { localCache } from "../utils/LocalCache.js";
import { logger } from "../services/logger.js";

/**
 * 系统设置仓储层
 * 使用 Cache 存储作为主存储，符合低频关键数据规则
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
            const memoryCached = localCache.get(cacheKey);
            if (memoryCached !== null) return memoryCached;

            // 1. 从 Cache 获取（主存储）
            const value = await cache.get(cacheKey, "text");
            if (value !== null) {
                localCache.set(cacheKey, value, 30 * 60 * 1000); // 内存缓存 30 分钟
                return value;
            }

            return defaultValue;
        } catch (e) {
            logger.error(`[${cache.getCurrentProvider()}] SettingsRepository.get failed for ${key}:`, e);
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
            // 1. 更新 Cache（主存储）
            await cache.set(cacheKey, value);
        } catch (cacheError) {
            logger.error(`[${cache.getCurrentProvider()}] SettingsRepository.set failed for ${key} (Cache):`, cacheError);
            throw cacheError; // Cache是主存储，失败时抛出异常
        }

        // 2. 更新内存缓存
        localCache.set(cacheKey, value, 30 * 60 * 1000);
    }
}