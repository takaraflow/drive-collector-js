import { kv } from "../services/kv.js";
import { cacheService } from "../utils/CacheService.js";

/**
 * 网盘配置仓储层
 * 使用 KV 存储作为主存储，符合低频关键数据规则
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
     * @returns {Promise<Object|null>}
     */
    static async findByUserId(userId) {
        if (!userId) return null;
        const cacheKey = `drive_${userId}`;

        try {
            return await cacheService.getOrSet(cacheKey, async () => {
                const drive = await kv.get(this.getDriveKey(userId), "json");
                return drive || null;
            }, 10 * 60 * 1000); // 缓存 10 分钟
        } catch (e) {
            console.error(`DriveRepository.findByUserId error for ${userId}:`, e);
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

            // 存储到 KV
            await kv.set(this.getDriveKey(userId), driveData);
            await kv.set(this.getDriveIdKey(driveId), driveData);

            // 更新活跃网盘列表
            await this._updateActiveDrivesList();

            cacheService.del(`drive_${userId}`);
            cacheService.del(this.getAllDrivesKey());
            return true;
        } catch (e) {
            console.error(`DriveRepository.create failed for ${userId}:`, e);
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
                await kv.delete(this.getDriveKey(userId));
                await kv.delete(this.getDriveIdKey(drive.id));
                await this._updateActiveDrivesList();
            }
            cacheService.del(`drive_${userId}`);
            cacheService.del(this.getAllDrivesKey());
        } catch (e) {
            console.error(`DriveRepository.deleteByUserId failed for ${userId}:`, e);
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
                await kv.delete(this.getDriveKey(drive.user_id));
                await kv.delete(this.getDriveIdKey(driveId));
                await this._updateActiveDrivesList();
            }
            cacheService.del(this.getAllDrivesKey());
        } catch (e) {
            console.error(`DriveRepository.delete failed for ${driveId}:`, e);
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
            return await kv.get(this.getDriveIdKey(driveId), "json");
        } catch (e) {
            console.error(`DriveRepository.findById error for ${driveId}:`, e);
            return null;
        }
    }

    /**
     * 获取所有活跃的网盘绑定
     * 注意：由于 KV 存储限制，findAll 在当前实现中返回空数组
     * 如需完整功能，可考虑使用 D1 存储网盘列表，但这会违反低频数据规则
     * @returns {Promise<Array>}
     */
    static async findAll() {
        // 由于 KV 不支持列出所有键，且为了遵循低频关键数据规则
        // 暂时返回空数组，避免使用 D1
        // 如需完整功能，需要重新设计架构
        console.warn("DriveRepository.findAll: 当前实现返回空数组，如需完整功能请重新设计");
        return [];
    }

    /**
     * 更新活跃网盘列表（由于 KV 限制，暂时无效）
     * @private
     */
    static async _updateActiveDrivesList() {
        // KV 不支持列出所有键，暂时不维护全局列表
        // 如需完整功能，需要重新设计
    }
}