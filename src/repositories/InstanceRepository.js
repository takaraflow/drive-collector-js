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

    static _readOptions(options = {}) {
        return options.strong === true || options.skipCache === true || options.skipL1 === true
            ? { skipCache: true }
            : {};
    }

    /**
     * 注册或更新实例信息
     * 使用 Cache 存储，设置 TTL 自动过期
     */
    static async upsert(instanceData) {
        const timeoutMs = instanceData.timeoutMs || this.DEFAULT_TIMEOUT;
        try {
            const result = await cache.set(`${this.PREFIX}${instanceData.id}`, instanceData, timeoutMs / 1000);
            if (result === false) {
                throw new Error(`Cache set returned false for ${instanceData.id}`);
            }
            return true;
        } catch (e) {
            log.error(`InstanceRepository.upsert failed for ${instanceData.id}:`, e);
            throw e;
        }
    }

    /**
     * 获取所有活跃实例
     */
    static async findAllActive(timeoutMs = this.DEFAULT_TIMEOUT, options = {}) {
        try {
            const instances = await this.findAll(options);
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
    static async findAll(options = {}) {
        try {
            const keys = await cache.listKeys(this.PREFIX);
            if (!keys || keys.length === 0) return [];

            const readOptions = this._readOptions(options);
            const instances = new Array(keys.length);
            let hasError = false;
            let currentIndex = 0;

            // ⚡ Bolt: Optimize sequential cache reads with a bounded native async worker pool
            // Reduces N+1 I/O wait time from O(N) to O(N/concurrency) while preserving order and bounding connection usage.
            const worker = async () => {
                while (currentIndex < keys.length && !hasError) {
                    const index = currentIndex++;
                    try {
                        instances[index] = await cache.get(keys[index], "json", readOptions);
                    } catch (err) {
                        hasError = true;
                        throw err;
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(5, keys.length) }, worker));
            return instances.filter(Boolean);
        } catch (e) {
            log.error("InstanceRepository.findAll failed:", e);
            return [];
        }
    }

    /**
     * 根据ID查找实例
     */
    static async findById(instanceId, options = {}) {
        try {
            return await cache.get(`${this.PREFIX}${instanceId}`, "json", this._readOptions(options));
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
            const existing = await this.findById(instanceId, { strong: true });
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
            const result = await cache.delete(`${this.PREFIX}${instanceId}`);
            if (result === false) {
                throw new Error(`Cache delete returned false for ${instanceId}`);
            }
            return true;
        } catch (e) {
            log.error(`InstanceRepository.markOffline failed for ${instanceId}:`, e);
            throw e;
        }
    }

    /**
     * 清理过期实例 (Cache 自动清理，此处为手动辅助)
     */
    static async deleteExpired(timeoutMs = 300000) {
        const now = Date.now();
        try {
            const all = await this.findAll({ strong: true });
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
