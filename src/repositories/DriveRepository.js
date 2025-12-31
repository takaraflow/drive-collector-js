import { cache } from "../services/CacheService.js";
import { localCache } from "../utils/LocalCache.js";
import { logger } from "../services/logger.js";

/**
 * 网盘配置仓储层
 * 使用 Cache 存储作为主存储，符合低频关键数据规则
 */
export class DriveRepository {
    static getDriveKey(userId) {
        return `drive:${userId}`;
    }

    static getDriveIdKey(driveId) {
        return `drive_id:${driveId}`;
    }

    static getAllDrivesKey() {
        return "drives:active";
    }

    /**
     * 获取用户的绑定网盘
     * @param {string} userId
     * @param {boolean} skipCache - 是否跳过缓存直接查询 KV
     * @returns {Promise<Object|null>}
     */
    static async findByUserId(userId, skipCache = false) {
        if (!userId) return null;
        const cacheKey = `drive_${userId}`;

        try {
            if (skipCache) {
                const drive = await cache.get(this.getDriveKey(userId), "json");
                return drive || null;
            }

            return await localCache.getOrSet(cacheKey, async () => {
                const drive = await cache.get(this.getDriveKey(userId), "json");
                return drive || null;
            }, 60 * 1000); // 缓存 1 分钟
        } catch (e) {
            logger.error(`DriveRepository.findByUserId error for ${userId}:`, e);
            return null;
        }
    }

    /**
     * 创建新的网盘绑定
     * @param {string} userId
     * @param {string} name - 网盘别名 (如 Mega-xxx@email.com)
     * @param {string} type - 网盘类型 (如 mega)
     * @param {Object} configData - 配置对象 (将被 JSON 序列化)
     * @returns {Promise<boolean>}
     */
    static async create(userId, name, type, configData) {
        if (!userId || !name || !configData) {
            throw new Error("DriveRepository.create: Missing required parameters.");
        }

        try {
            const driveId = `drive_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const driveData = {
                id: driveId,
                user_id: userId.toString(),
                name,
                type,
                config_data: configData,
                status: 'active',
                created_at: Date.now()
            };

            // 存储到 Cache
            await cache.set(this.getDriveKey(userId), driveData);
            await cache.set(this.getDriveIdKey(driveId), driveData);

            // 更新活跃网盘列表
            await this._updateActiveDrivesList();

            localCache.del(`drive_${userId}`);
            localCache.del(this.getAllDrivesKey());
            return true;
        } catch (e) {
            logger.error(`DriveRepository.create failed for ${userId}:`, e);
            throw e;
        }
    }

    /**
     * 删除用户的网盘绑定
     * @param {string} userId
     * @returns {Promise<void>}
     */
    static async deleteByUserId(userId) {
        if (!userId) return;
        try {
            const drive = await this.findByUserId(userId);
            if (drive) {
                await cache.delete(this.getDriveKey(userId));
                await cache.delete(this.getDriveIdKey(drive.id));
                await this._updateActiveDrivesList();
            }
            localCache.del(`drive_${userId}`);
            localCache.del(this.getAllDrivesKey());
        } catch (e) {
            logger.error(`DriveRepository.deleteByUserId failed for ${userId}:`, e);
            throw e;
        }
    }

    /**
     * 删除指定的网盘绑定
     * @param {string} driveId
     * @returns {Promise<void>}
     */
    static async delete(driveId) {
        if (!driveId) return;
        try {
            const drive = await this.findById(driveId);
            if (drive) {
                await cache.delete(this.getDriveKey(drive.user_id));
                await cache.delete(this.getDriveIdKey(driveId));
                await this._updateActiveDrivesList();
            }
            localCache.del(this.getAllDrivesKey());
        } catch (e) {
            logger.error(`DriveRepository.delete failed for ${driveId}:`, e);
            throw e;
        }
    }

    /**
     * 根据 ID 获取网盘配置
     * @param {string} driveId
     * @returns {Promise<Object|null>}
     */
    static async findById(driveId) {
        if (!driveId) return null;
        try {
            return await cache.get(this.getDriveIdKey(driveId), "json");
        } catch (e) {
            logger.error(`DriveRepository.findById error for ${driveId}:`, e);
            return null;
        }
    }

    /**
     * 获取所有活跃的网盘绑定
     * @returns {Promise<Array>}
     */
    static async findAll() {
        try {
            const activeIds = await cache.get(this.getAllDrivesKey(), "json") || [];
            if (activeIds.length === 0) return [];

            const drives = [];
            for (const id of activeIds) {
                const drive = await this.findById(id);
                if (drive) drives.push(drive);
            }
            return drives;
        } catch (e) {
            logger.error("DriveRepository.findAll error:", e);
            return [];
        }
    }

    /**
     * 更新活跃网盘列表
     * @private
     */
    static async _updateActiveDrivesList() {
        try {
            // 使用 listKeys 发现所有驱动（前缀 drive: 但排除 drive_id:）
            const keys = await cache.listKeys('drive:');
            const activeIds = [];
            
            for (const key of keys) {
                const drive = await cache.get(key, "json");
                if (drive && drive.id) {
                    activeIds.push(drive.id);
                }
            }
            
            await cache.set(this.getAllDrivesKey(), activeIds);
            logger.info(`📝 已更新活跃网盘列表，共 ${activeIds.length} 个`);
        } catch (e) {
            logger.error("Failed to update active drives list:", e);
        }
    }
}