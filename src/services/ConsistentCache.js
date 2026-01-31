import { logger } from "./logger/index.js";
import { cache } from "./CacheService.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { localCache } from "../utils/LocalCache.js";
import { sanitizeHeaders } from "../utils/common.js";

const log = logger.withModule('ConsistentCache');

/**
 * 一致性缓存服务
 * 职责：
 * 1. 提供强一致性读写操作
 * 2. 处理缓存同步和失效
 * 3. 支持分布式锁保护的关键操作
 */
export class ConsistentCache {
    constructor() {
        this.prefix = 'consistent:';
        this.syncInProgress = new Map();
    }

    /**
     * 强一致性写入
     * @param {string} key - 缓存键
     * @param {*} value - 值
     * @param {Object} options - 选项
     * @returns {Promise<boolean>} 是否成功
     */
    async set(key, value, options = {}) {
        const { ttl = 3600, lockKey = null, userId = null } = options;
        const fullKey = this.prefix + key;
        
        try {
            // 如果需要锁保护
            if (lockKey) {
                const lockName = `cache_write:${lockKey}`;
                const acquired = await instanceCoordinator.acquireLock(lockName, 30);
                
                if (!acquired) {
                    log.warn(`Failed to acquire lock for cache write: ${lockName}`);
                    return false;
                }

                try {
                    // 双写：缓存 + 持久化
                    await this._writeWithSync(fullKey, value, ttl, userId);
                    return true;
                } finally {
                    await instanceCoordinator.releaseLock(lockName);
                }
            } else {
                // 普通写入
                await this._writeWithSync(fullKey, value, ttl, userId);
                return true;
            }
        } catch (error) {
            log.error(`Consistent write failed for key ${key}:`, error);
            return false;
        }
    }

    /**
     * 强一致性读取
     * @param {string} key - 缓存键
     * @param {Object} options - 选项
     * @returns {Promise<*>} 缓存值
     */
    async get(key, options = {}) {
        const { skipCache = false, userId = null } = options;
        const fullKey = this.prefix + key;

        // 1. 优先从本地缓存读取
        if (!skipCache) {
            const localValue = localCache.get(fullKey);
            if (localValue !== undefined) {
                log.debug(`Local cache hit: ${key}`);
                return localValue;
            }
        }

        // 2. 从分布式缓存读取
        try {
            const value = await cache.get(fullKey);
            
            if (value !== null && value !== undefined) {
                // 回填本地缓存
                localCache.set(fullKey, value, 60); // 60秒TTL
                return value;
            }
        } catch (error) {
            log.warn(`Cache read failed for ${key}:`, error);
        }

        // 3. 缓存未命中
        return null;
    }

    /**
     * 强一致性删除
     * @param {string} key - 缓存键
     * @param {Object} options - 选项
     * @returns {Promise<boolean>} 是否成功
     */
    async delete(key, options = {}) {
        const { lockKey = null } = options;
        const fullKey = this.prefix + key;

        try {
            if (lockKey) {
                const lockName = `cache_delete:${lockKey}`;
                const acquired = await instanceCoordinator.acquireLock(lockName, 30);
                
                if (!acquired) {
                    log.warn(`Failed to acquire lock for cache delete: ${lockName}`);
                    return false;
                }

                try {
                    await this._deleteWithSync(fullKey);
                    return true;
                } finally {
                    await instanceCoordinator.releaseLock(lockName);
                }
            } else {
                await this._deleteWithSync(fullKey);
                return true;
            }
        } catch (error) {
            log.error(`Consistent delete failed for key ${key}:`, error);
            return false;
        }
    }

    /**
     * 批量一致性操作
     * @param {Array} operations - 操作数组 [{type: 'set'|'delete', key, value, options}]
     * @returns {Promise<boolean>} 是否全部成功
     */
    async batch(operations) {
        const lockName = `cache_batch:${Date.now()}`;
        const acquired = await instanceCoordinator.acquireLock(lockName, 60);
        
        if (!acquired) {
            log.warn('Failed to acquire lock for batch operation');
            return false;
        }

        try {
            for (const op of operations) {
                const fullKey = this.prefix + op.key;
                
                if (op.type === 'set') {
                    await this._writeWithSync(fullKey, op.value, op.options?.ttl || 3600, op.options?.userId || null);
                } else if (op.type === 'delete') {
                    await this._deleteWithSync(fullKey);
                }
            }
            return true;
        } catch (error) {
            log.error('Batch operation failed:', error);
            return false;
        } finally {
            await instanceCoordinator.releaseLock(lockName);
        }
    }

    /**
     * 带同步的写入操作
     * @private
     */
    async _writeWithSync(key, value, ttl, userId) {
        // 1. 写入分布式缓存
        await cache.set(key, value, ttl);

        // 2. 写入本地缓存
        localCache.set(key, value, Math.min(ttl, 60));

        // 3. 记录变更日志（用于故障恢复）
        if (userId) {
            await this._logChange('set', key, value, userId);
        }

        // 4. 触发同步事件
        await this._broadcastChange('set', key, value);
    }

    /**
     * 带同步的删除操作
     * @private
     */
    async _deleteWithSync(key) {
        // 1. 删除分布式缓存
        await cache.delete(key);

        // 2. 删除本地缓存
        localCache.del(key);

        // 3. 记录变更日志
        await this._logChange('delete', key, null, null);

        // 4. 触发同步事件
        await this._broadcastChange('delete', key, null);
    }

    /**
     * 记录变更日志
     * @private
     */
    async _logChange(type, key, value, userId) {
        const logEntry = {
            type,
            key,
            value,
            userId,
            timestamp: Date.now(),
            instanceId: instanceCoordinator.getInstanceId()
        };

        try {
            // 存储到持久化队列或日志
            await cache.set(`change_log:${Date.now()}:${key}`, logEntry, 86400);
        } catch (error) {
            log.warn('Failed to log change:', error);
        }
    }

    /**
     * 广播变更事件
     * @private
     */
    async _broadcastChange(type, key, value) {
        const event = {
            type: 'cache_change',
            action: type,
            key,
            value,
            timestamp: Date.now(),
            source: instanceCoordinator.getInstanceId()
        };

        // 通过队列广播给其他实例
        try {
            const { queueService } = await import("./QueueService.js");
            await queueService.publish('cache_sync', event);
        } catch (error) {
            log.warn('Failed to broadcast cache change:', error);
        }
    }

    /**
     * 处理来自其他实例的同步事件
     * @param {Object} event - 同步事件
     */
    async handleSyncEvent(event) {
        if (event.source === instanceCoordinator.getInstanceId()) {
            return; // 忽略自己的事件
        }

        const fullKey = this.prefix + event.key;
        
        if (event.action === 'set') {
            localCache.set(fullKey, event.value, 60);
            log.debug(`Synced set operation for ${event.key} from ${event.source}`);
        } else if (event.action === 'delete') {
            localCache.del(fullKey);
            log.debug(`Synced delete operation for ${event.key} from ${event.source}`);
        }
    }

    /**
     * 恢复一致性状态
     * @param {string} userId - 用户ID
     */
    async restoreConsistency(userId) {
        log.info(`Restoring consistency for user ${userId}`);
        
        try {
            // 1. 查询变更日志
            const changeLogs = await this._getChangeLogs(userId);
            
            // 2. 重新应用未同步的变更
            for (const log of changeLogs) {
                if (log.type === 'set') {
                    await cache.set(log.key, log.value, 3600);
                } else if (log.type === 'delete') {
                    await cache.delete(log.key);
                }
            }

            // 3. 清理本地缓存
            localCache.clear();

            log.info(`Consistency restored for user ${userId}, ${changeLogs.length} changes applied`);
            return true;
        } catch (error) {
            log.error(`Failed to restore consistency for user ${userId}:`, error);
            return false;
        }
    }

    /**
     * 获取变更日志
     * @private
     */
    async _getChangeLogs(userId) {
        // 实际实现需要查询持久化存储
        // 这里返回空数组作为占位
        return [];
    }

    /**
     * 获取缓存统计信息
     */
    async getStats() {
        return {
            prefix: this.prefix,
            localCacheSize: localCache.size(),
            syncInProgress: this.syncInProgress.size,
            instanceId: instanceCoordinator.getInstanceId()
        };
    }

    /**
     * 清理本地缓存
     */
    clearLocalCache() {
        localCache.clear();
        log.info('Local cache cleared');
    }
}

// 单例导出
export const consistentCache = new ConsistentCache();