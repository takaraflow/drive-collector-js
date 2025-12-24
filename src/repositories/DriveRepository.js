import { d1 } from "../services/d1.js";
import { cacheService } from "../utils/CacheService.js";

/**
 * 网盘配置仓储层
 * 负责 'user_drives' 表的 CRUD
 */
export class DriveRepository {
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
                return await d1.fetchOne(
                    "SELECT * FROM user_drives WHERE user_id = ? AND status = 'active'", 
                    [userId.toString()]
                );
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
            const configJson = JSON.stringify(configData);
            await d1.run(`
                INSERT INTO user_drives (user_id, name, type, config_data, status, created_at)
                VALUES (?, ?, ?, ?, 'active', ?)
            `, [userId.toString(), name, type, configJson, Date.now()]);
            cacheService.del(`drive_${userId}`);
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
            await d1.run("DELETE FROM user_drives WHERE user_id = ?", [userId.toString()]);
            cacheService.del(`drive_${userId}`);
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
            await d1.run("DELETE FROM user_drives WHERE id = ?", [driveId.toString()]);
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
            return await d1.fetchOne(
                "SELECT * FROM user_drives WHERE id = ? AND status = 'active'",
                [driveId.toString()]
            );
        } catch (e) {
            console.error(`DriveRepository.findById error for ${driveId}:`, e);
            return null;
        }
    }

    /**
     * 获取所有活跃的网盘绑定
     * @returns {Promise<Array>}
     */
    static async findAll() {
        try {
            return await d1.fetchAll("SELECT * FROM user_drives WHERE status = 'active'");
        } catch (e) {
            console.error("DriveRepository.findAll error:", e);
            return [];
        }
    }
}