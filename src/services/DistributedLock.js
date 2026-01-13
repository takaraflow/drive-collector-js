/**
 * DistributedLock - 分布式锁服务
 * 解决锁泄漏与死锁问题
 * 
 * 功能特性：
 * 1. 自动过期机制（TTL）
 * 2. 心跳续期
 * 3. 锁偷取（处理过期锁）
 * 4. 强制释放（用于恢复场景）
 * 5. 锁状态监控
 */

export class DistributedLock {
    /**
     * @param {Object} cache - 缓存服务实例
     * @param {Object} options - 配置选项
     */
    constructor(cache, options = {}) {
        this.cache = cache;
        this.logger = options.logger || console;
        
        this.options = {
            ttlSeconds: options.ttlSeconds || 120,           // 默认2分钟TTL
            heartbeatInterval: options.heartbeatInterval || 10000,  // 10秒心跳
            renewalThreshold: options.renewalThreshold || 30000,    // 30秒续期阈值
            timeout: options.timeout || 10000,               // 获取锁超时
            maxRetries: options.maxRetries || 3,             // 最大重试次数
            ...options
        };

        // 本地锁状态管理
        this.locks = new Map(); // taskId -> { owner, expiresAt, heartbeatId, version }
        
        // 启动定期清理任务
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredLocks();
        }, 60000); // 每分钟清理一次
    }

    /**
     * 获取锁（带自动续期）
     * @param {string} taskId - 任务ID
     * @param {string} instanceId - 实例ID
     * @param {Object} options - 获取选项
     * @returns {Promise<Object>} - { success, stolen, reason }
     */
    async acquire(taskId, instanceId, options = {}) {
        const {
            ttlSeconds = this.options.ttlSeconds,
            timeout = this.options.timeout,
            maxRetries = this.options.maxRetries
        } = options;

        const lockKey = `lock:task:${taskId}`;
        const now = Date.now();
        const expiresAt = now + ttlSeconds * 1000;
        const version = Math.random().toString(36).substr(2, 9);

        const lockValue = {
            instanceId,
            owner: instanceId,
            acquiredAt: now,
            expiresAt,
            version,
            heartbeatCount: 0
        };

        // 尝试获取锁（带重试）
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // 尝试原子获取锁
                const acquired = await this.cache.compareAndSet(lockKey, lockValue, {
                    ifNotExists: true,
                    metadata: { 
                        ttl: ttlSeconds,
                        taskId,
                        instanceId
                    }
                });

                if (acquired) {
                    // 成功获取锁，启动心跳
                    this.startHeartbeat(taskId, instanceId, ttlSeconds, version);
                    
                    this.logger.info(`Lock acquired for task ${taskId} by ${instanceId}`, {
                        version,
                        expiresAt: new Date(expiresAt).toISOString()
                    });
                    
                    return { 
                        success: true, 
                        stolen: false,
                        version
                    };
                }

                // 锁已被占用，检查是否过期
                const existing = await this.cache.get(lockKey, 'json');
                if (existing && this.isExpired(existing)) {
                    // 尝试偷取过期锁
                    const stolen = await this.attemptLockSteal(lockKey, lockValue, existing, ttlSeconds);
                    
                    if (stolen.success) {
                        this.startHeartbeat(taskId, instanceId, ttlSeconds, version);
                        
                        this.logger.warn(`Lock stolen for task ${taskId} from ${existing.instanceId}`, {
                            oldVersion: existing.version,
                            newVersion: version
                        });
                        
                        return { 
                            success: true, 
                            stolen: true,
                            stolenFrom: existing.instanceId,
                            version
                        };
                    }
                    
                    if (stolen.reason === 'race_condition') {
                        // 竞争条件，重试
                        continue;
                    }
                }

                // 锁被其他实例持有
                if (attempt === maxRetries - 1) {
                    return { 
                        success: false, 
                        reason: 'lock_held',
                        currentOwner: existing?.instanceId,
                        expiresAt: existing?.expiresAt
                    };
                }

                // 等待后重试
                await this.sleep(100 * (attempt + 1));

            } catch (error) {
                this.logger.error(`Lock acquisition attempt ${attempt + 1} failed for task ${taskId}`, error);
                
                if (attempt === maxRetries - 1) {
                    return { 
                        success: false, 
                        reason: 'error',
                        error: error.message
                    };
                }
            }
        }

        return { success: false, reason: 'max_retries' };
    }

    /**
     * 尝试偷取过期锁
     */
    async attemptLockSteal(lockKey, newLockValue, existingLock, ttlSeconds) {
        // 再次验证锁确实过期
        if (!this.isExpired(existingLock)) {
            return { success: false, reason: 'not_expired' };
        }

        // 使用 compareAndSet 原子偷取
        const stolen = await this.cache.compareAndSet(lockKey, {
            ...newLockValue,
            stolenFrom: existingLock.instanceId,
            stolenAt: Date.now(),
            stolenReason: 'expired'
        }, {
            metadata: { 
                ttl: ttlSeconds,
                stolen: true,
                from: existingLock.instanceId
            }
        });

        if (stolen) {
            return { success: true };
        }

        // 偷取失败，可能是竞争条件
        return { success: false, reason: 'race_condition' };
    }

    /**
     * 启动心跳续期
     */
    startHeartbeat(taskId, instanceId, ttlSeconds, version) {
        const initialExpiresAt = Date.now() + ttlSeconds * 1000;
        const heartbeat = setInterval(async () => {
            try {
                const lockKey = `lock:task:${taskId}`;
                const current = await this.cache.get(lockKey, 'json');
                
                // 检查锁是否还属于当前实例
                if (!current || current.instanceId !== instanceId || current.version !== version) {
                    this.logger.warn(`Heartbeat stopped: lock lost for task ${taskId}`, {
                        currentInstance: current?.instanceId,
                        myInstance: instanceId,
                        currentVersion: current?.version,
                        myVersion: version
                    });
                    clearInterval(heartbeat);
                    this.locks.delete(taskId);
                    return;
                }

                // 检查是否需要续期
                const now = Date.now();
                const timeUntilExpiry = current.expiresAt - now;
                
                if (timeUntilExpiry <= this.options.renewalThreshold) {
                    // 需要续期
                    const newExpiresAt = now + ttlSeconds * 1000;
                    const newValue = {
                        ...current,
                        expiresAt: newExpiresAt,
                        heartbeatCount: (current.heartbeatCount || 0) + 1
                    };

                    // 使用 compareAndSet 确保原子性
                    const renewed = await this.cache.compareAndSet(lockKey, newValue, {
                        metadata: { 
                            ttl: ttlSeconds,
                            action: 'renewal'
                        }
                    });

                    if (renewed) {
                        this.logger.debug(`Lock renewed for task ${taskId}`, {
                            newExpiresAt: new Date(newExpiresAt).toISOString(),
                            heartbeatCount: newValue.heartbeatCount
                        });
                    } else {
                        // 续期失败，锁可能已被其他操作修改
                        this.logger.warn(`Lock renewal failed for task ${taskId}, stopping heartbeat`);
                        clearInterval(heartbeat);
                        this.locks.delete(taskId);
                    }
                }

            } catch (error) {
                this.logger.error(`Heartbeat failed for task ${taskId}`, error);
                // 继续尝试，不立即停止
            }
        }, this.options.heartbeatInterval);

        // 保存心跳引用
        this.locks.set(taskId, {
            owner: instanceId,
            expiresAt: initialExpiresAt,
            heartbeatId: heartbeat,
            version
        });
    }

    /**
     * 释放锁
     * @param {string} taskId - 任务ID
     * @param {string} instanceId - 实例ID
     * @returns {Promise<boolean>} - 是否成功释放
     */
    async release(taskId, instanceId) {
        const lockKey = `lock:task:${taskId}`;
        
        try {
            // 获取当前锁信息
            const current = await this.cache.get(lockKey, 'json');
            
            // 验证锁的拥有者
            if (!current) {
                this.logger.warn(`Attempted to release non-existent lock for task ${taskId}`);
                this.cleanupLocalLock(taskId);
                return true;
            }

            if (current.instanceId !== instanceId) {
                this.logger.warn(`Attempted to release lock owned by another instance`, {
                    taskId,
                    requestedBy: instanceId,
                    actualOwner: current.instanceId
                });
                this.cleanupLocalLock(taskId);
                return false;
            }

            // 停止心跳
            this.cleanupLocalLock(taskId);

            // 删除锁
            await this.cache.delete(lockKey);
            
            this.logger.info(`Lock released for task ${taskId} by ${instanceId}`);
            return true;

        } catch (error) {
            this.logger.error(`Error releasing lock for task ${taskId}`, error);
            this.cleanupLocalLock(taskId);
            return false;
        }
    }

    /**
     * 强制释放锁（用于恢复场景）
     * @param {string} taskId - 任务ID
     * @param {string} adminInstanceId - 管理实例ID
     */
    async forceRelease(taskId, adminInstanceId) {
        const lockKey = `lock:task:${taskId}`;
        
        try {
            const current = await this.cache.get(lockKey, 'json');
            
            // 停止心跳
            this.cleanupLocalLock(taskId);

            // 删除锁
            await this.cache.delete(lockKey);
            
            this.logger.warn(`Lock forcefully released`, {
                taskId,
                releasedBy: adminInstanceId,
                previousOwner: current?.instanceId
            });

            return true;
        } catch (error) {
            this.logger.error(`Error force releasing lock for task ${taskId}`, error);
            return false;
        }
    }

    /**
     * 检查锁是否过期
     */
    isExpired(lock) {
        if (!lock || !lock.expiresAt) return true;
        return Date.now() > lock.expiresAt;
    }

    /**
     * 获取锁状态
     * @param {string} taskId - 任务ID
     * @returns {Promise<Object>} - 锁状态
     */
    async getLockStatus(taskId) {
        const lockKey = `lock:task:${taskId}`;
        const lock = await this.cache.get(lockKey, 'json');
        
        if (!lock) {
            return { 
                status: 'released',
                taskId 
            };
        }

        const isExpired = this.isExpired(lock);
        const remainingMs = Math.max(0, lock.expiresAt - Date.now());

        return {
            status: isExpired ? 'expired' : 'held',
            taskId,
            owner: lock.instanceId,
            version: lock.version,
            acquiredAt: lock.acquiredAt,
            expiresAt: lock.expiresAt,
            remainingMs,
            heartbeatCount: lock.heartbeatCount || 0,
            stolenFrom: lock.stolenFrom,
            stolenAt: lock.stolenAt
        };
    }

    /**
     * 检查当前实例是否持有指定任务的锁
     * @param {string} taskId - 任务ID
     * @param {string} instanceId - 实例ID
     * @returns {Promise<boolean>}
     */
    async isLockHeldBy(taskId, instanceId) {
        const status = await this.getLockStatus(taskId);
        return status.status === 'held' && status.owner === instanceId;
    }

    /**
     * 清理过期锁（定时任务）
     */
    async cleanupExpiredLocks() {
        const pattern = 'lock:task:*';
        
        try {
            const keys = await this.cache.listKeys(pattern);
            
            for (const key of keys) {
                const lock = await this.cache.get(key, 'json');
                if (lock && this.isExpired(lock)) {
                    // 检查本地是否还有心跳
                    const taskId = key.replace('lock:task:', '');
                    const localLock = this.locks.get(taskId);
                    
                    if (localLock && localLock.owner === lock.instanceId) {
                        // 本地还有心跳，说明锁可能正在续期中，跳过
                        continue;
                    }

                    // 删除过期锁
                    await this.cache.delete(key);
                    this.logger.info(`Cleaned up expired lock: ${key}`, {
                        expiredAt: new Date(lock.expiresAt).toISOString(),
                        owner: lock.instanceId
                    });
                }
            }
        } catch (error) {
            this.logger.error('Error cleaning up expired locks', error);
        }
    }

    /**
     * 清理本地锁记录
     */
    cleanupLocalLock(taskId) {
        const lockInfo = this.locks.get(taskId);
        if (lockInfo?.heartbeatId) {
            clearInterval(lockInfo.heartbeatId);
        }
        this.locks.delete(taskId);
    }

    /**
     * 释放当前实例持有的所有锁
     * @param {string} instanceId - 实例ID
     */
    async releaseAll(instanceId) {
        const tasksToRelease = [];
        
        for (const [taskId, lockInfo] of this.locks) {
            if (lockInfo.owner === instanceId) {
                tasksToRelease.push(this.release(taskId, instanceId));
            }
        }

        if (tasksToRelease.length > 0) {
            const results = await Promise.allSettled(tasksToRelease);
            this.logger.info(`Released ${results.filter(r => r.status === 'fulfilled' && r.value).length} locks on shutdown`);
        }
    }

    /**
     * 获取当前实例持有的所有锁
     * @returns {Array<string>} - 任务ID列表
     */
    getHeldLocks() {
        const locks = [];
        for (const [taskId, lockInfo] of this.locks) {
            locks.push({
                taskId,
                owner: lockInfo.owner,
                expiresAt: lockInfo.expiresAt
            });
        }
        return locks;
    }

    /**
     * 获取锁统计信息
     */
    async getStats() {
        const pattern = 'lock:task:*';
        const keys = await this.cache.listKeys(pattern);
        
        let held = 0;
        let expired = 0;
        let total = keys.length;

        for (const key of keys) {
            const lock = await this.cache.get(key, 'json');
            if (lock) {
                if (this.isExpired(lock)) {
                    expired++;
                } else {
                    held++;
                }
            }
        }

        return {
            total,
            held,
            expired,
            local: this.locks.size,
            timestamp: Date.now()
        };
    }

    /**
     * 优雅关闭
     */
    async shutdown() {
        // 停止清理任务
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        // 停止所有本地心跳
        for (const [taskId, lockInfo] of this.locks) {
            if (lockInfo.heartbeatId) {
                clearInterval(lockInfo.heartbeatId);
            }
        }

        this.locks.clear();
    }

    /**
     * 辅助方法：休眠
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 工厂函数
export function createDistributedLock(cache, options = {}) {
    return new DistributedLock(cache, options);
}

export default DistributedLock;
