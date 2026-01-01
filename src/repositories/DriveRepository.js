import { cache } from "../services/CacheService.js";
import { localCache } from "../utils/LocalCache.js";
import { d1 } from "../services/d1.js";
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
     * 获取用户的绑定网盘 (Read-Through)
     * @param {string} userId
     * @param {boolean} skipCache - 是否跳过缓存直接查询 D1
     * @returns {Promise<Object|null>}
     */
    static async findByUserId(userId, skipCache = false) {
        if (!userId) return null;
        const cacheKey = `drive_${userId}`;

        if (skipCache) {
            // 直接从 D1 查询
            return await this._findDriveInD1(userId);
        }

        // 先尝试从内存缓存获取
        let drive = localCache.get(cacheKey);
        if (drive !== null) return drive;

        // 从 Cache 获取
        try {
            drive = await cache.get(this.getDriveKey(userId), "json");
            if (drive) {
                localCache.set(cacheKey, drive, 60 * 1000); // 缓存 1 分钟
                return drive;
            }
        } catch (cacheError) {
            logger.warn(`Cache unavailable for ${userId}, falling back to D1:`, cacheError);
        }

        // Cache miss 或失败，从 D1 回源
        drive = await this._findDriveInD1(userId);
        if (drive) {
            try {
                await cache.set(this.getDriveKey(userId), drive);
            } catch (cacheError) {
                logger.warn(`Failed to update cache for ${userId}:`, cacheError);
            }
            localCache.set(cacheKey, drive, 60 * 1000);
        }

        return drive;
    }

    /**
     * 创建新的网盘绑定 (Write-Through)
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
            const now = Date.now();
            const driveData = {
                id: driveId,
                user_id: userId.toString(),
                name,
                type,
                config_data: configData,
                status: 'active',
                created_at: now
            };

            // Write-Through: 先写入 D1
            await d1.run(
                "INSERT INTO drives (id, user_id, name, type, config_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [driveId, userId.toString(), name, type, JSON.stringify(configData), 'active', now, now]
            );

            // 再写入 Cache
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
     * 删除用户的网盘绑定 (Write-Through)
     * @param {string} userId
     * @returns {Promise<void>}
     */
    static async deleteByUserId(userId) {
        if (!userId) return;
        try {
            const drive = await this.findByUserId(userId);
            if (drive) {
                // Write-Through: 先删除 D1
                await d1.run("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", [Date.now(), drive.id]);

                // 再删除 Cache
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
     * 删除指定的网盘绑定 (Write-Through)
     * @param {string} driveId
     * @returns {Promise<void>}
     */
    static async delete(driveId) {
        if (!driveId) return;
        try {
            const drive = await this.findById(driveId);
            if (drive) {
                // Write-Through: 先删除 D1
                await d1.run("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", [Date.now(), driveId]);

                // 再删除 Cache
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
     * 根据 ID 获取网盘配置 (Read-Through)
     * @param {string} driveId
     * @returns {Promise<Object|null>}
     */
    static async findById(driveId) {
        if (!driveId) return null;
        try {
            // 先从 Cache 获取
            let drive = await cache.get(this.getDriveIdKey(driveId), "json");
            if (drive) return drive;

            // Cache miss，从 D1 回源
            drive = await d1.fetchOne(
                "SELECT id, user_id, name, type, config_data, status, created_at FROM drives WHERE id = ? AND status = 'active'",
                [driveId]
            );

            // 如果找到，写入 Cache
            if (drive) {
                await cache.set(this.getDriveIdKey(driveId), drive);
            }

            return drive;
        } catch (e) {
            logger.error(`DriveRepository.findById error for ${driveId}:`, e);
            return null;
        }
    }

    /**
     * 获取所有活跃的网盘绑定 (Read-Through)
     * @returns {Promise<Array>}
     */
    static async findAll() {
        try {
            // 先从 Cache 获取活跃列表
            let activeIds = await cache.get(this.getAllDrivesKey(), "json") || [];
            if (activeIds.length === 0) {
                // Cache 为空，从 D1 获取所有活跃 drives
                const drives = await d1.fetchAll(
                    "SELECT id FROM drives WHERE status = 'active' ORDER BY created_at DESC"
                );
                activeIds = drives.map(d => d.id);

                // 更新 Cache
                if (activeIds.length > 0) {
                    await cache.set(this.getAllDrivesKey(), activeIds);
                }
            }

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
     * 从 D1 数据库查找用户的网盘配置
     * @private
     * @param {string} userId
     * @returns {Promise<Object|null>}
     */
    static async _findDriveInD1(userId) {
        // 🛡️ 防御性编程：确保 userId 有效
        if (userId === undefined || userId === null) {
            return null;
        }

        // 强制转换为字符串，避免对象或 undefined 传入 D1
        const safeUserId = String(userId);

        try {
            const result = await d1.fetchOne(
                "SELECT id, user_id, name, type, config_data, status, created_at FROM drives WHERE user_id = ? AND status = 'active'",
                [safeUserId]
            );
            return result;
        } catch (e) {
            logger.error(`DriveRepository._findDriveInD1 error for ${safeUserId}:`, e);
            return null;
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