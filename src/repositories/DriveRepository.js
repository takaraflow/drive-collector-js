import crypto from "crypto";
import { cache } from "../services/CacheService.js";
import { localCache } from "../utils/LocalCache.js";
import { d1 } from "../services/d1.js";
import { logger } from "../services/logger/index.js";
import { CACHE_KEYS } from "../domain/cache-keys.js";
import { DRIVE_COLUMNS, DRIVE_STATUSES, isDefaultDrive } from "../domain/drive.js";
import {
    RCLONE_OBSCURED_PASSWORD_DRIVE_TYPES,
    hasPasswordCredential,
    hasExplicitRclonePasswordFormat,
    markLegacyUnknownRclonePasswordConfig
} from "../domain/drive-credentials.js";

const log = logger.withModule ? logger.withModule('DriveRepository') : logger;

/**
 * 网盘配置仓储层
 * D1 是绑定关系与默认盘的事实源；Cache/LocalCache 只做派生读缓存。
 */
export class DriveRepository {
    static getDriveKey(userId) {
        return CACHE_KEYS.driveByUser(userId);
    }

    static getDriveIdKey(driveId) {
        return CACHE_KEYS.driveById(driveId);
    }

    static getAllDrivesKey() {
        return CACHE_KEYS.activeDrives();
    }

    static getLocalDriveKey(userId) {
        return CACHE_KEYS.localDriveByUser(userId);
    }

    static _getChanges(result) {
        if (!result) return 0;
        if (Number.isFinite(result.changes)) return result.changes;
        if (Number.isFinite(result.meta?.changes)) return result.meta.changes;
        return result.success === true ? 1 : 0;
    }

    static async clearUserDriveCache(userId, driveIds = []) {
        if (!userId) return;
        const uniqueDriveIds = [...new Set((driveIds || []).filter(Boolean))];
        await Promise.allSettled([
            cache.delete(this.getDriveKey(userId)),
            cache.delete(this.getAllDrivesKey()),
            ...uniqueDriveIds.map(driveId => cache.delete(this.getDriveIdKey(driveId)))
        ]);
        localCache.del(this.getLocalDriveKey(userId));
        localCache.del(this.getAllDrivesKey());
    }

    static _parseConfigData(configData) {
        if (!configData) return {};
        if (typeof configData === "object") return { ...configData };
        try {
            return JSON.parse(configData);
        } catch {
            return {};
        }
    }

    static _needsLegacyPasswordFormatMigration(drive) {
        if (
            !drive?.id ||
            !drive?.user_id ||
            drive.status !== DRIVE_STATUSES.ACTIVE ||
            !RCLONE_OBSCURED_PASSWORD_DRIVE_TYPES.includes(String(drive.type || "").toLowerCase())
        ) {
            return false;
        }
        const configData = this._parseConfigData(drive.config_data);
        return hasPasswordCredential(configData) && !hasExplicitRclonePasswordFormat(configData);
    }

    static _markLegacyPasswordFormat(drive) {
        const configData = this._parseConfigData(drive.config_data);
        return markLegacyUnknownRclonePasswordConfig(configData);
    }

    static async _migrateLegacyPasswordFormat(drive) {
        if (!this._needsLegacyPasswordFormatMigration(drive)) return drive;
        const migratedConfig = this._markLegacyPasswordFormat(drive);
        const serializedConfigData = JSON.stringify(migratedConfig);
        const now = Date.now();
        await d1.run(
            "UPDATE drives SET config_data = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?",
            [serializedConfigData, now, drive.id, String(drive.user_id), DRIVE_STATUSES.ACTIVE]
        );
        const migratedDrive = {
            ...drive,
            config_data: serializedConfigData,
            updated_at: now
        };
        await this.clearUserDriveCache(drive.user_id, [drive.id]);
        return migratedDrive;
    }

    static async _migrateLegacyPasswordFormats(drives = []) {
        const list = Array.isArray(drives) ? drives : [drives].filter(Boolean);
        const migrated = [];
        for (const drive of list) {
            migrated.push(await this._migrateLegacyPasswordFormat(drive));
        }
        return migrated;
    }

    /**
     * 获取用户的所有绑定网盘 (Read-Through)
     * @param {string} userId
     * @param {boolean} skipCache - 是否跳过缓存直接查询 D1
     * @returns {Promise<Array>}
     */
    static async findByUserId(userId, skipCache = false) {
        if (!userId) return [];
        const cacheKey = this.getLocalDriveKey(userId);

        if (skipCache) {
            return await this._findDriveInD1(userId);
        }

        let drives = localCache.get(cacheKey);
        if (drives !== null) {
            return await this._migrateLegacyPasswordFormats(drives);
        }

        try {
            drives = await cache.get(this.getDriveKey(userId), "json");
            if (drives) {
                const migratedDrives = await this._migrateLegacyPasswordFormats(drives);
                localCache.set(cacheKey, migratedDrives, 60 * 1000);
                return migratedDrives;
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
            const serializedConfigData = JSON.stringify(configData);
            const driveData = {
                id: driveId,
                user_id: userId.toString(),
                name,
                type,
                config_data: serializedConfigData,
                status: DRIVE_STATUSES.ACTIVE,
                is_default: 0,
                created_at: now
            };

            const existingActive = await d1.fetchOne(
                `SELECT ${DRIVE_COLUMNS} FROM drives WHERE user_id = ? AND type = ? AND status = ? LIMIT 1`,
                [userId.toString(), type, DRIVE_STATUSES.ACTIVE]
            );
            if (existingActive) {
                throw new Error(`DriveRepository.create: Active drive already exists for user ${userId} and type ${type}.`);
            }

            const existingDeleted = await d1.fetchOne(
                `SELECT ${DRIVE_COLUMNS} FROM drives WHERE user_id = ? AND type = ? AND status = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
                [userId.toString(), type, DRIVE_STATUSES.DELETED]
            );

            if (existingDeleted) {
                driveData.id = existingDeleted.id;
                driveData.created_at = existingDeleted.created_at || now;
                await d1.run(
                    "UPDATE drives SET name = ?, config_data = ?, remote_folder = NULL, status = ?, is_default = 0, updated_at = ? WHERE id = ? AND user_id = ? AND type = ? AND status = ?",
                    [name, serializedConfigData, DRIVE_STATUSES.ACTIVE, now, existingDeleted.id, userId.toString(), type, DRIVE_STATUSES.DELETED]
                );
            } else {
                // Write-Through: 先写入 D1
                await d1.run(
                    "INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [driveId, userId.toString(), name, type, serializedConfigData, DRIVE_STATUSES.ACTIVE, 0, now, now]
                );
            }

            await cache.set(this.getDriveIdKey(driveData.id), driveData);
            await this.clearUserDriveCache(userId);

            // 更新活跃网盘列表
            await this._updateActiveDrivesList();

            return true;
        } catch (e) {
            log.error(`DriveRepository.create failed for ${userId}:`, e);
            throw e;
        }
    }

    static async updateConfigData(userId, driveId, configData) {
        if (!userId || !driveId || !configData) {
            throw new Error("DriveRepository.updateConfigData: Missing required parameters.");
        }

        const now = Date.now();
        const serializedConfigData = JSON.stringify(configData);
        await d1.run(
            "UPDATE drives SET config_data = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?",
            [serializedConfigData, now, driveId, String(userId), DRIVE_STATUSES.ACTIVE]
        );
        await this.clearUserDriveCache(userId, [driveId]);
        return true;
    }

    /**
     * 删除用户的所有网盘绑定 (Write-Through)
     * @param {string} userId
     * @returns {Promise<void>}
     */
    static async deleteByUserId(userId) {
        if (!userId) return;
        try {
            const drives = await this._findDriveInD1(userId);
            
            if (drives && drives.length > 0) {
                const now = Date.now();
                for (const drive of drives) {
                    await d1.run(
                        "UPDATE drives SET status = ?, is_default = 0, updated_at = ? WHERE id = ?",
                        [DRIVE_STATUSES.DELETED, now, drive.id]
                    );
                    await cache.delete(this.getDriveIdKey(drive.id));
                }
                await this._updateActiveDrivesList();
            }

            await this.clearUserDriveCache(userId, drives.map(drive => drive.id));
        } catch (e) {
            log.error(`DriveRepository.deleteByUserId failed for ${userId}:`, e);
            throw e;
        }
    }

    /**
     * 删除指定用户的网盘绑定 (Write-Through)
     * @param {string} userId
     * @param {string} driveId
     * @returns {Promise<boolean>}
     */
    static async delete(userId, driveId) {
        if (!userId || !driveId) return false;
        try {
            const drive = await this.findByUserAndId(userId, driveId);
            if (!drive) {
                localCache.del(this.getAllDrivesKey());
                return false;
            }

            // Write-Through: 先删除 D1
            const result = await d1.run(
                "UPDATE drives SET status = ?, is_default = 0, updated_at = ? WHERE id = ? AND user_id = ?",
                [DRIVE_STATUSES.DELETED, Date.now(), driveId, String(userId)]
            );
            const deleted = this._getChanges(result) > 0;
            if (!deleted) {
                localCache.del(this.getAllDrivesKey());
                return false;
            }

            await this.clearUserDriveCache(userId, [driveId]);
            await this._updateActiveDrivesList();
            localCache.del(this.getAllDrivesKey());
            return deleted;
        } catch (e) {
            log.error(`DriveRepository.delete failed for ${userId}/${driveId}:`, e);
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
            if (drive) {
                const [migratedDrive] = await this._migrateLegacyPasswordFormats(drive);
                return migratedDrive || null;
            }

            // Cache miss，从 D1 回源
            drive = await d1.fetchOne(
                `SELECT ${DRIVE_COLUMNS} FROM drives WHERE id = ? AND status = ?`,
                [driveId, DRIVE_STATUSES.ACTIVE]
            );
            const [migratedDrive] = await this._migrateLegacyPasswordFormats(drive);

            // 如果找到，写入 Cache
            if (migratedDrive) {
                await cache.set(this.getDriveIdKey(driveId), migratedDrive);
            }

            return migratedDrive || null;
        } catch (e) {
            log.error(`DriveRepository.findById error for ${driveId}:`, e);
            return null;
        }
    }

    /**
     * 根据用户和 ID 获取网盘配置 (Read-Through)
     * @param {string} userId
     * @param {string} driveId
     * @returns {Promise<Object|null>}
     */
    static async findByUserAndId(userId, driveId) {
        if (!userId || !driveId) return null;
        const drive = await this.findById(driveId);
        if (!drive || String(drive.user_id) !== String(userId)) {
            return null;
        }
        return drive;
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
                    "SELECT id FROM drives WHERE status = ? ORDER BY created_at DESC",
                    [DRIVE_STATUSES.ACTIVE]
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
                `SELECT ${DRIVE_COLUMNS} FROM drives WHERE user_id = ? AND status = ? ORDER BY is_default DESC, created_at DESC`,
                [safeUserId, DRIVE_STATUSES.ACTIVE]
            );
            return await this._migrateLegacyPasswordFormats(result || []);
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
                localCache.del(this.getLocalDriveKey(userId));
                
                // 清理文件列表缓存，因为路径变更会影响文件列表
                await cache.delete(CACHE_KEYS.filesByUser(userId));
                localCache.del(CACHE_KEYS.filesByUser(userId));
                
                // 清理可能的路径缓存
                localCache.del(CACHE_KEYS.uploadPathByUser(userId));
                
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
            const drives = await d1.fetchAll(
                "SELECT id FROM drives WHERE status = ? ORDER BY created_at DESC",
                [DRIVE_STATUSES.ACTIVE]
            );
            const activeIds = (drives || []).map(drive => drive.id).filter(Boolean);
            await cache.set(this.getAllDrivesKey(), activeIds);
            log.info(`📝 已更新活跃网盘列表，共 ${activeIds.length} 个`);
        } catch (e) {
            log.error("Failed to update active drives list:", e);
        }
    }

    static async getDefaultDrive(userId) {
        const drives = await this.findByUserId(userId);
        if (!drives || drives.length === 0) return null;
        return drives.find(isDefaultDrive) || drives[0];
    }

    static async setDefaultDrive(userId, driveId) {
        if (!userId || !driveId) {
            throw new Error("DriveRepository.setDefaultDrive: Missing required parameters.");
        }

        const drive = await d1.fetchOne(
            `SELECT ${DRIVE_COLUMNS} FROM drives WHERE id = ? AND user_id = ? AND status = ?`,
            [driveId, String(userId), DRIVE_STATUSES.ACTIVE]
        );
        if (!drive || String(drive.user_id) !== String(userId)) {
            throw new Error("DriveRepository.setDefaultDrive: Drive not found for user.");
        }

        const userDriveIds = (await this._findDriveInD1(userId)).map(item => item.id);
        await d1.run(
            "UPDATE drives SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ? WHERE user_id = ? AND status = ?",
            [driveId, Date.now(), String(userId), DRIVE_STATUSES.ACTIVE]
        );
        await this.clearUserDriveCache(userId, userDriveIds);
        await this._updateActiveDrivesList();
        return true;
    }

    static async clearDefaultDrive(userId) {
        if (!userId) return;
        const userDriveIds = (await this._findDriveInD1(userId)).map(item => item.id);
        await d1.run(
            "UPDATE drives SET is_default = 0, updated_at = ? WHERE user_id = ? AND status = ?",
            [Date.now(), String(userId), DRIVE_STATUSES.ACTIVE]
        );
        await this.clearUserDriveCache(userId, userDriveIds);
    }
}
