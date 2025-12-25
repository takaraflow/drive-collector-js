import { d1 } from "../services/d1.js";

/**
 * 实例数据仓储层
 * 负责管理多实例相关的数据持久化
 */
export class InstanceRepository {

    /**
     * 创建实例表（如果不存在）
     */
    static async createTableIfNotExists() {
        try {
            await d1.run(`
                CREATE TABLE IF NOT EXISTS instances (
                    id TEXT PRIMARY KEY,
                    hostname TEXT,
                    region TEXT,
                    started_at INTEGER,
                    last_heartbeat INTEGER,
                    status TEXT DEFAULT 'active',
                    created_at INTEGER,
                    updated_at INTEGER
                )
            `);
        } catch (e) {
            console.error("InstanceRepository.createTableIfNotExists failed:", e);
        }
    }

    /**
     * 注册或更新实例信息
     */
    static async upsert(instanceData) {
        const now = Date.now();
        try {
            await d1.run(`
                INSERT INTO instances (id, hostname, region, started_at, last_heartbeat, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    hostname = excluded.hostname,
                    region = excluded.region,
                    last_heartbeat = excluded.last_heartbeat,
                    status = excluded.status,
                    updated_at = excluded.updated_at
            `, [
                instanceData.id,
                instanceData.hostname || 'unknown',
                instanceData.region || 'unknown',
                instanceData.startedAt,
                instanceData.lastHeartbeat,
                instanceData.status || 'active',
                now,
                now
            ]);
            return true;
        } catch (e) {
            console.error(`InstanceRepository.upsert failed for ${instanceData.id}:`, e);
            return false;
        }
    }

    /**
     * 获取所有活跃实例
     */
    static async findAllActive(timeoutMs = 120000) {
        const now = Date.now();
        const deadline = now - timeoutMs;

        try {
            return await d1.fetchAll(`
                SELECT * FROM instances
                WHERE last_heartbeat >= ?
                AND status = 'active'
                ORDER BY id ASC
            `, [deadline]);
        } catch (e) {
            console.error("InstanceRepository.findAllActive failed:", e);
            return [];
        }
    }

    /**
     * 获取所有实例（包括过期的）
     */
    static async findAll() {
        try {
            return await d1.fetchAll(`
                SELECT * FROM instances
                ORDER BY id ASC
            `);
        } catch (e) {
            console.error("InstanceRepository.findAll failed:", e);
            return [];
        }
    }

    /**
     * 根据ID查找实例
     */
    static async findById(instanceId) {
        try {
            return await d1.fetchOne(`
                SELECT * FROM instances WHERE id = ?
            `, [instanceId]);
        } catch (e) {
            console.error(`InstanceRepository.findById failed for ${instanceId}:`, e);
            return null;
        }
    }

    /**
     * 更新实例心跳
     */
    static async updateHeartbeat(instanceId, heartbeatTime = Date.now()) {
        try {
            await d1.run(`
                UPDATE instances
                SET last_heartbeat = ?, updated_at = ?
                WHERE id = ?
            `, [heartbeatTime, Date.now(), instanceId]);
            return true;
        } catch (e) {
            console.error(`InstanceRepository.updateHeartbeat failed for ${instanceId}:`, e);
            return false;
        }
    }

    /**
     * 标记实例为离线
     */
    static async markOffline(instanceId) {
        try {
            await d1.run(`
                UPDATE instances
                SET status = 'offline', updated_at = ?
                WHERE id = ?
            `, [Date.now(), instanceId]);
            return true;
        } catch (e) {
            console.error(`InstanceRepository.markOffline failed for ${instanceId}:`, e);
            return false;
        }
    }

    /**
     * 删除过期实例
     */
    static async deleteExpired(timeoutMs = 300000) { // 5分钟超时
        const now = Date.now();
        const deadline = now - timeoutMs;

        try {
            const result = await d1.run(`
                DELETE FROM instances
                WHERE last_heartbeat < ?
                OR (status != 'active' AND updated_at < ?)
            `, [deadline, deadline]);

            return result.changes || 0;
        } catch (e) {
            console.error("InstanceRepository.deleteExpired failed:", e);
            return 0;
        }
    }

    /**
     * 获取实例统计信息
     */
    static async getStats(timeoutMs = 120000) {
        const now = Date.now();
        const deadline = now - timeoutMs;

        try {
            const stats = await d1.fetchOne(`
                SELECT
                    COUNT(CASE WHEN last_heartbeat >= ? AND status = 'active' THEN 1 END) as active_count,
                    COUNT(CASE WHEN status = 'offline' THEN 1 END) as offline_count,
                    COUNT(*) as total_count,
                    MIN(last_heartbeat) as oldest_heartbeat,
                    MAX(last_heartbeat) as newest_heartbeat
                FROM instances
            `, [deadline]);

            return {
                activeCount: stats.active_count || 0,
                offlineCount: stats.offline_count || 0,
                totalCount: stats.total_count || 0,
                oldestHeartbeat: stats.oldest_heartbeat,
                newestHeartbeat: stats.newest_heartbeat
            };
        } catch (e) {
            console.error("InstanceRepository.getStats failed:", e);
            return {
                activeCount: 0,
                offlineCount: 0,
                totalCount: 0,
                oldestHeartbeat: null,
                newestHeartbeat: null
            };
        }
    }
}