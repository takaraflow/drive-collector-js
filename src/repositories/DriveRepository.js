import { cache } from "../services/CacheService.js";
import { localCache } from "../utils/LocalCache.js";
import { d1 } from "../services/d1.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('DriveRepository') : logger;

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
     * 获取用户的所有绑定网盘 (Read-Through)
     * @param {string} userId
     * @param {boolean} skipCache - 是否跳过缓存直接查询 D1
     * @returns {Promise<Array>}
     */
    static async findByUserId(userId, skipCache = false) {
        if (!userId) return [];
        const cacheKey = `drive_${userId}`;

        if (skipCache) {
            return await this._findDriveInD1(userId);
        }

        let drives = localCache.get(cacheKey);
        if (drives !== null) {
            return Array.isArray(drives) ? drives : [drives].filter(Boolean);
        }

        try {
            drives = await cache.get(this.getDriveKey(userId), "json");
            if (drives) {
                localCache.set(cacheKey, drives, 60 * 1000);
                return Array.isArray(drives) ? drives : [drives].filter(Boolean);
            }
        } catch (cacheError) {
            log.warn(`Cache unavailable for ${userId}, falling back to D1:`, cacheError);
        }

        drives = await this._findDriveInD1(userId);
        if (drives && drives.length > 0) {
            try {
                await cache.set(this.getDriveKey(userId), drives);
            } catch (cacheError) {
                log.warn(`Failed to update cache for ${userId}:`, cacheError);
            }
            localCache.set(cacheKey, drives, 60 * 1000);
        }

        return drives || [];
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
            const driveId = `drive_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
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

            // 更新 Cache (追加到列表)
            const cacheKey = this.getDriveKey(userId);
            let existingDrives = [];
            try {
                existingDrives = await cache.get(cacheKey, "json");
                if (!Array.isArray(existingDrives)) {
                    existingDrives = [];
                }
            } catch (e) {
                log.warn(`Failed to get existing drives from cache for ${userId}:`, e);
            }

            const updatedDrives = [...existingDrives, driveData];
            await cache.set(cacheKey, updatedDrives);
            await cache.set(this.getDriveIdKey(driveId), driveData);

            // 更新活跃网盘列表
            await this._updateActiveDrivesList();

            localCache.del(`drive_${userId}`);
            localCache.del(this.getAllDrivesKey());
            return true;
        } catch (e) {
            log.error(`DriveRepository.create failed for ${userId}:`, e);
            throw e;
        }
    }

    /**
     * 删除用户的所有网盘绑定 (Write-Through)
     * @param {string} userId
     * @returns {Promise<void>}
     */
    static async deleteByUserId(userId) {
        if (!userId) return;
        try {
            const drives = await this.findByUserId(userId);
            
            if (drives && drives.length > 0) {
                const now = Date.now();
                for (const drive of drives) {
                    await d1.run("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", [now, drive.id]);
                    await cache.delete(this.getDriveIdKey(drive.id));
                }
                await this._updateActiveDrivesList();
            }

            await cache.delete(this.getDriveKey(userId));
            localCache.del(`drive_${userId}`);
            localCache.del(this.getAllDrivesKey());
        } catch (e) {
            log.error(`DriveRepository.deleteByUserId failed for ${userId}:`, e);
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

                // 更新用户网盘列表缓存
                const cacheKey = this.getDriveKey(drive.user_id);
                let drives = [];
                try {
                    drives = await cache.get(cacheKey, "json");
                    if (Array.isArray(drives)) {
                        const updatedDrives = drives.filter(d => d.id !== driveId);
                        await cache.set(cacheKey, updatedDrives);
                    }
                } catch (e) {
                    log.warn(`Failed to update user drives cache for ${drive.user_id}:`, e);
                }

                // 删除单个网盘缓存
                await cache.delete(this.getDriveIdKey(driveId));
                await this._updateActiveDrivesList();
            }
            localCache.del(this.getAllDrivesKey());
        } catch (e) {
            log.error(`DriveRepository.delete failed for ${driveId}:`, e);
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
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE id = ? AND status = 'active'",
                [driveId]
            );

            // 如果找到，写入 Cache
            if (drive) {
                await cache.set(this.getDriveIdKey(driveId), drive);
            }

            return drive;
        } catch (e) {
            log.error(`DriveRepository.findById error for ${driveId}:`, e);
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
            log.error("DriveRepository.findAll error:", e);
            return [];
        }
    }

    /**
     * 从 D1 数据库查找用户的所有网盘配置
     * @private
     * @param {string} userId
     * @returns {Promise<Array>}
     */
    static async _findDriveInD1(userId) {
        if (userId === undefined || userId === null) {
            return [];
        }

        const safeUserId = String(userId);

        try {
            const result = await d1.fetchAll(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC",
                [safeUserId]
            );
            return result || [];
        } catch (e) {
            log.error(`DriveRepository._findDriveInD1 error for ${safeUserId}:`, e);
            return [];
        }
    }

    /**
     * 更新网盘的remote_folder字段
     * @param {string} driveId - 网盘ID
     * @param {string|null} remoteFolder - 上传路径，null表示重置为默认
     * @param {string} userId - 用户ID（用于清理缓存）
     * @returns {Promise<void>}
     */
    static async updateRemoteFolder(driveId, remoteFolder, userId) {
        if (!driveId) return;
        
        const now = Date.now();
        
        try {
            // 更新 D1
            await d1.run(
                "UPDATE drives SET remote_folder = ?, updated_at = ? WHERE id = ?",
                [remoteFolder, now, driveId]
            );
            
            // 清除所有相关缓存，强制下次读取时回源
            if (userId) {
                // 清理网盘配置相关缓存
                await cache.delete(this.getDriveKey(userId));
                await cache.delete(this.getDriveIdKey(driveId));
                localCache.del(`drive_${userId}`);
                
                // 清理文件列表缓存，因为路径变更会影响文件列表
                await cache.delete(`files_${userId}`);
                localCache.del(`files_${userId}`);
                
                // 清理可能的路径缓存
                localCache.del(`upload_path_${userId}`);
                
                log.info(`Cleared all related caches for user ${userId} after path update`);
            }
            
            log.info(`Updated remote_folder for drive ${driveId}: ${remoteFolder}`);
        } catch (e) {
            log.error(`DriveRepository.updateRemoteFolder failed for ${driveId}:`, e);
            throw e;
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
                if (key.startsWith('drive_id:')) {
                    continue;
                }
                const drive = await cache.get(key, "json");
                if (drive && drive.id) {
                    activeIds.push(drive.id);
                }
            }

            await cache.set(this.getAllDrivesKey(), activeIds);
            log.info(`📝 已更新活跃网盘列表，共 ${activeIds.length} 个`);
        } catch (e) {
            log.error("Failed to update active drives list:", e);
        }
    }
}
