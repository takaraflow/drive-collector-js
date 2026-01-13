import { cache } from "../services/CacheService.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('InstanceRepository') : logger;

/**
 * 实例数据仓储层 (Cache 版)
 * 负责管理多实例相关的数据，完全基于 Cache 实现以支持异地多实例和快速心跳
 */
export class InstanceRepository {
    static PREFIX = 'instance:';
    static DEFAULT_TIMEOUT = 120000; // 120秒

    /**
     * 注册或更新实例信息
     * 使用 Cache 存储，设置 TTL 自动过期
     */
    static async upsert(instanceData) {
        const timeoutMs = instanceData.timeoutMs || this.DEFAULT_TIMEOUT;
        try {
            await cache.set(`${this.PREFIX}${instanceData.id}`, instanceData, timeoutMs / 1000);
            return true;
        } catch (e) {
            log.error(`InstanceRepository.upsert failed for ${instanceData.id}:`, e);
            return false;
        }
    }

    /**
     * 获取所有活跃实例
     */
    static async findAllActive(timeoutMs = this.DEFAULT_TIMEOUT) {
        try {
            const instances = await this.findAll();
            const now = Date.now();
            return instances.filter(inst => 
                inst.lastHeartbeat && (now - inst.lastHeartbeat) < timeoutMs
            );
        } catch (e) {
            log.error("InstanceRepository.findAllActive failed:", e);
            return [];
        }
    }

    /**
     * 获取所有实例
     */
    static async findAll() {
        try {
            const keys = await cache.listKeys(this.PREFIX);
            const instances = [];
            for (const key of keys) {
                const data = await cache.get(key, "json", { cacheTtl: 30000 });
                if (data) {
                    instances.push(data);
                }
            }
            return instances;
        } catch (e) {
            log.error("InstanceRepository.findAll failed:", e);
            return [];
        }
    }

    /**
     * 根据ID查找实例
     */
    static async findById(instanceId) {
        try {
            return await cache.get(`${this.PREFIX}${instanceId}`, "json");
        } catch (e) {
            log.error(`InstanceRepository.findById failed for ${instanceId}:`, e);
            return null;
        }
    }

    /**
     * 更新实例心跳
     */
    static async updateHeartbeat(instanceId, heartbeatTime = Date.now(), timeoutMs = this.DEFAULT_TIMEOUT) {
        try {
            const existing = await this.findById(instanceId);
            if (!existing) return false;

            const updated = {
                ...existing,
                lastHeartbeat: heartbeatTime,
                updatedAt: Date.now()
            };
            return await this.upsert(updated);
        } catch (e) {
            log.error(`InstanceRepository.updateHeartbeat failed for ${instanceId}:`, e);
            return false;
        }
    }

    /**
     * 标记实例为离线 (直接删除)
     */
    static async markOffline(instanceId) {
        try {
            await cache.delete(`${this.PREFIX}${instanceId}`);
            return true;
        } catch (e) {
            log.error(`InstanceRepository.markOffline failed for ${instanceId}:`, e);
            return false;
        }
    }

    /**
     * 清理过期实例 (Cache 自动清理，此处为手动辅助)
     */
    static async deleteExpired(timeoutMs = 300000) {
        const now = Date.now();
        try {
            const all = await this.findAll();
            let count = 0;
            for (const inst of all) {
                if ((now - inst.lastHeartbeat) > timeoutMs) {
                    await this.markOffline(inst.id);
                    count++;
                }
            }
            return count;
        } catch (e) {
            log.error("InstanceRepository.deleteExpired failed:", e);
            return 0;
        }
    }

    /**
     * 获取实例统计信息
     */
    static async getStats(timeoutMs = 120000) {
        try {
            const all = await this.findAll();
            const now = Date.now();
            const active = all.filter(inst => (now - inst.lastHeartbeat) < timeoutMs);
            
            return {
                activeCount: active.length,
                totalCount: all.length,
                offlineCount: all.length - active.length,
                newestHeartbeat: Math.max(...all.map(i => i.lastHeartbeat || 0)) || null
            };
        } catch (e) {
            log.error("InstanceRepository.getStats failed:", e);
            return { activeCount: 0, totalCount: 0, offlineCount: 0, newestHeartbeat: null };
        }
    }
}
