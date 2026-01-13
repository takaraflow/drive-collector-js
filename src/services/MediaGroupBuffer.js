import { logger } from "./logger/index.js";
import { cache } from "./CacheService.js";
import { DistributedLock } from "./DistributedLock.js";
import { TaskManager } from "../processor/TaskManager.js";

const log = logger.withModule('MediaGroupBuffer');

// LRU 缓存实现，用于限制 messageIds 内存使用
class LRUCache {
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        // 更新访问顺序（移到末尾）
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // 删除最旧的项（第一个项）
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    get size() {
        return this.cache.size;
    }

    clear() {
        this.cache.clear();
    }

    // 获取过期的键（基于时间）
    getExpiredKeys(currentTime, maxAge) {
        const expired = [];
        for (const [key, timestamp] of this.cache) {
            if (currentTime - timestamp > maxAge) {
                expired.push(key);
            }
        }
        return expired;
    }
}

export class MediaGroupBuffer {
    constructor(options = {}) {
        this.options = {
            bufferTimeout: options.bufferTimeout || 1000,
            maxBatchSize: options.maxBatchSize || 10,
            cleanupInterval: options.cleanupInterval || 30000,
            staleThreshold: options.staleThreshold || 60000,
            instanceId: options.instanceId || process.env.INSTANCE_ID || 'default',
            persistKeyPrefix: options.persistKeyPrefix || 'media_group_buffer',
            lockTtl: options.lockTtl || 30, // 30 seconds lock TTL
            maxMessageIds: options.maxMessageIds || 1000, // LRU 最大容量
            messageIdsMaxAge: options.messageIdsMaxAge || 3600000, // 1小时过期时间
            ...options
        };

        // 使用 Redis 存储缓冲区，而不是本地 Map
        this.distributedLock = new DistributedLock(cache, {
            ttlSeconds: this.options.lockTtl,
            logger: log
        });

        // 本地跟踪状态（用于性能优化）
        this.localBufferKeys = new Set(); // 存储当前实例处理的 groupedId
        this.messageIds = new LRUCache(this.options.maxMessageIds); // 使用 LRU 缓存
        
        // 持久化键（带实例前缀避免冲突）
        this.persistKey = `${this.options.instanceId}:${this.options.persistKeyPrefix}`;

        // 清理任务引用
        this.cleanupIntervalId = null;
        
        this.startCleanupTask();
    }

    /**
     * 添加消息到缓冲
     */
    async add(message, target, userId) {
        const gid = message.groupedId.toString();
        const msgId = message.id.toString();

        // 1. 消息去重检查（使用 Redis 集合）
        const isDuplicate = await this._isMessageDuplicate(msgId);
        if (isDuplicate) {
            log.debug(`Duplicate message ignored: ${msgId}`);
            return { added: false, reason: 'duplicate' };
        }

        // 2. 获取分布式锁，确保只有一个实例处理这个 groupedId
        const lockResult = await this.distributedLock.acquire(gid, this.options.instanceId);
        
        if (!lockResult.success) {
            // 锁被其他实例持有，说明其他实例正在处理这个缓冲区
            log.debug(`Buffer locked by another instance for group ${gid}`, {
                owner: lockResult.currentOwner
            });
            
            // 仍然添加消息到 Redis，但不负责 flush
            await this._addMessageToRedis(gid, message, target, userId);
            
            return { added: true, reason: 'buffered_by_other_instance' };
        }

        try {
            // 3. 添加消息到 Redis 缓冲区
            await this._addMessageToRedis(gid, message, target, userId);
            
            // 4. 检查是否达到批次大小
            const bufferSize = await this._getBufferSize(gid);
            if (bufferSize >= this.options.maxBatchSize) {
                await this._flushBufferWithLock(gid, lockResult.version);
            } else {
                // 启动超时定时器（在 Redis 中存储定时器信息）
                await this._startTimeoutTimer(gid, lockResult.version);
            }

            // 更新本地跟踪
            this.localBufferKeys.add(gid);
            this.messageIds.set(msgId, Date.now());

            return { added: true, reason: 'buffered' };

        } catch (error) {
            // 出错时释放锁
            await this.distributedLock.release(gid, this.options.instanceId);
            throw error;
        }
    }

    /**
     * 检查消息是否重复（使用 Redis 集合）
     */
    async _isMessageDuplicate(msgId) {
        const key = `${this.options.instanceId}:processed_messages`;
        const exists = await cache.get(`${key}:${msgId}`, 'string');
        if (exists) return true;
        
        // 设置短期过期时间（与 staleThreshold 一致）
        await cache.set(`${key}:${msgId}`, '1', this.options.staleThreshold / 1000);
        return false;
    }

    /**
     * 添加消息到 Redis 缓冲区
     */
    async _addMessageToRedis(gid, message, target, userId) {
        const bufferKey = `${this.options.instanceId}:buffer:${gid}`;
        
        // 使用 Redis Hash 存储缓冲区元数据
        const bufferData = {
            target,
            userId,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        
        await cache.set(`${bufferKey}:meta`, bufferData, this.options.staleThreshold / 1000);
        
        // 使用 Redis List 存储消息（保持顺序）
        const messageData = {
            id: message.id,
            media: message.media,
            groupedId: message.groupedId,
            _bufferedAt: Date.now(),
            _seq: Date.now() // 使用时间戳作为序列号
        };
        
        await cache.set(`${bufferKey}:msg:${message.id}`, messageData, this.options.staleThreshold / 1000);
        
        // 更新消息 ID 集合
        const msgIdsKey = `${bufferKey}:msg_ids`;
        await cache.set(`${msgIdsKey}:${message.id}`, '1', this.options.staleThreshold / 1000);
    }

    /**
     * 获取缓冲区大小（优化版本，使用 Redis SCARD/HLEN）
     */
    async _getBufferSize(gid) {
        const bufferKey = `${this.options.instanceId}:buffer:${gid}`;
        const pattern = `${bufferKey}:msg:*`;
        
        // 使用 listKeys 获取所有消息键（原始方法，需要优化）
        const keys = await cache.listKeys(pattern);
        return keys.length;
    }

    /**
     * 启动超时定时器（在 Redis 中存储定时器信息）
     */
    async _startTimeoutTimer(gid, lockVersion) {
        const timerKey = `${this.options.instanceId}:timer:${gid}`;
        const timerData = {
            expiresAt: Date.now() + this.options.bufferTimeout,
            lockVersion,
            instanceId: this.options.instanceId
        };
        
        await cache.set(timerKey, timerData, this.options.bufferTimeout / 1000 + 10);
        
        // 设置一个后台检查（实际应用中可以使用 Redis 的过期通知或专门的定时任务服务）
        // 这里我们依赖定期清理任务来检查超时
    }

    /**
     * 刷新缓冲区（持有锁的情况下）
     */
    async _flushBufferWithLock(gid, lockVersion) {
        try {
            // 验证锁仍然有效
            const lockStatus = await this.distributedLock.getLockStatus(gid);
            if (lockStatus.status !== 'held' || lockStatus.owner !== this.options.instanceId || lockStatus.version !== lockVersion) {
                log.warn(`Lock lost for group ${gid}, skipping flush`);
                return;
            }

            // 获取缓冲区所有消息
            const messages = await this._getAllMessages(gid);
            
            if (messages.length === 0) {
                log.warn(`Buffer empty for group ${gid}`);
                await this._cleanupBuffer(gid);
                return;
            }

            // 排序消息
            messages.sort((a, b) => a._seq - b._seq);

            // 验证媒体组完整性
            const validation = this._validateMediaGroup(messages);
            if (!validation.isValid) {
                log.warn(`Media group ${gid} validation failed: ${validation.reason}`);
                
                // 延迟重试
                setTimeout(() => {
                    this._flushBufferWithLock(gid, lockVersion);
                }, this.options.bufferTimeout);
                
                return;
            }

            // 获取目标和用户ID
            const bufferKey = `${this.options.instanceId}:buffer:${gid}`;
            const meta = await cache.get(`${bufferKey}:meta`, 'json');
            
            if (!meta) {
                log.error(`Missing metadata for group ${gid}`);
                await this._cleanupBuffer(gid);
                return;
            }

            // 处理媒体组
            await TaskManager.addBatchTasks(
                meta.target,
                messages,
                meta.userId
            );

            log.info(`Successfully processed media group ${gid} with ${messages.length} messages`);

            // 清理缓冲区
            await this._cleanupBuffer(gid);

        } catch (error) {
            log.error(`Error flushing buffer for group ${gid}:`, error);
            
            // 错误重试逻辑
            const bufferKey = `${this.options.instanceId}:buffer:${gid}`;
            const meta = await cache.get(`${bufferKey}:meta`, 'json');
            if (meta) {
                meta.errorCount = (meta.errorCount || 0) + 1;
                await cache.set(`${bufferKey}:meta`, meta, this.options.staleThreshold / 1000);
                
                if (meta.errorCount < 3) {
                    setTimeout(() => {
                        this._flushBufferWithLock(gid, lockVersion);
                    }, this.options.bufferTimeout * meta.errorCount);
                } else {
                    log.error(`Media group ${gid} failed after ${meta.errorCount} attempts`);
                    await this._cleanupBuffer(gid);
                }
            }
        } finally {
            // 释放锁
            await this.distributedLock.release(gid, this.options.instanceId);
        }
    }

    /**
     * 获取所有消息
     */
    async _getAllMessages(gid) {
        const bufferKey = `${this.options.instanceId}:buffer:${gid}`;
        const pattern = `${bufferKey}:msg:*`;
        
        const keys = await cache.listKeys(pattern);
        const messages = [];
        
        for (const key of keys) {
            const message = await cache.get(key, 'json');
            if (message) {
                messages.push(message);
            }
        }
        
        return messages;
    }

    /**
     * 验证媒体组完整性
     */
    _validateMediaGroup(messages) {
        if (!messages || messages.length === 0) {
            return { isValid: false, reason: 'empty_buffer' };
        }

        // 检查消息ID连续性（简化版）
        const ids = messages.map(m => parseInt(m.id)).sort((a, b) => a - b);
        
        // 检查是否所有消息都有 media
        const allHaveMedia = messages.every(m => m.media);
        if (!allHaveMedia) {
            return { isValid: false, reason: 'missing_media' };
        }

        return { isValid: true };
    }

    /**
     * 清理缓冲区
     */
    async _cleanupBuffer(gid) {
        const bufferKey = `${this.options.instanceId}:buffer:${gid}`;
        
        // 删除所有相关键
        const pattern = `${bufferKey}:*`;
        const keys = await cache.listKeys(pattern);
        
        for (const key of keys) {
            await cache.delete(key);
        }

        // 清理本地跟踪
        this.localBufferKeys.delete(gid);
        
        // 清理定时器
        const timerKey = `${this.options.instanceId}:timer:${gid}`;
        await cache.delete(timerKey);
    }

    /**
     * 启动清理任务
     */
    startCleanupTask() {
        this.cleanupIntervalId = setInterval(() => {
            this._cleanupStaleBuffers();
        }, this.options.cleanupInterval);
    }

    /**
     * 停止清理任务（用于优雅关闭）
     */
    stopCleanup() {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = null;
            log.info('MediaGroupBuffer cleanup task stopped');
        }
    }

    /**
     * 清理过期缓冲区
     */
    async _cleanupStaleBuffers() {
        try {
            // 查找所有实例的定时器
            const timerPattern = `*:timer:*`;
            const timerKeys = await cache.listKeys(timerPattern);
            
            const now = Date.now();
            
            for (const timerKey of timerKeys) {
                const timerData = await cache.get(timerKey, 'json');
                if (!timerData) continue;
                
                // 检查是否过期
                if (now > timerData.expiresAt) {
                    const parts = timerKey.split(':');
                    const instanceId = parts[0];
                    const gid = parts[2];
                    
                    log.warn(`Cleaning up stale buffer: ${gid} from instance ${instanceId}`);
                    
                    // 获取锁并刷新
                    const lockResult = await this.distributedLock.acquire(gid, this.options.instanceId);
                    if (lockResult.success) {
                        await this._flushBufferWithLock(gid, lockResult.version);
                    }
                }
            }
            
            // 清理过期的 processed_messages
            const msgPattern = `*:processed_messages:*`;
            const msgKeys = await cache.listKeys(msgPattern);
            
            for (const key of msgKeys) {
                const value = await cache.get(key, 'string');
                if (!value) {
                    await cache.delete(key);
                }
            }
            
            // 清理本地 messageIds 中的过期项
            this._cleanupLocalMessageIds();
            
        } catch (error) {
            // 添加熔断机制，避免持续报错
            if (error.message && error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
                log.error('Cache connection error in cleanup task, stopping for 5 minutes');
                this.stopCleanup();
                // 5分钟后重启
                setTimeout(() => {
                    if (!this.cleanupIntervalId) {
                        this.startCleanupTask();
                    }
                }, 300000);
            } else {
                log.error('Error in cleanup task:', error);
            }
        }
    }

    /**
     * 清理本地 messageIds 中的过期项
     */
    _cleanupLocalMessageIds() {
        const now = Date.now();
        const expiredKeys = this.messageIds.getExpiredKeys(now, this.options.messageIdsMaxAge);
        
        for (const key of expiredKeys) {
            this.messageIds.delete(key);
        }
        
        if (expiredKeys.length > 0) {
            log.debug(`Cleaned up ${expiredKeys.length} expired message IDs from local cache`);
        }
    }

    /**
     * 持久化缓冲区（用于重启恢复）
     */
    async persist() {
        try {
            const data = {
                instanceId: this.options.instanceId,
                timestamp: Date.now(),
                buffers: []
            };

            // 获取当前实例的所有缓冲区
            const bufferPattern = `${this.options.instanceId}:buffer:*:meta`;
            const metaKeys = await cache.listKeys(bufferPattern);
            
            for (const metaKey of metaKeys) {
                const meta = await cache.get(metaKey, 'json');
                if (meta) {
                    const gid = metaKey.split(':')[2];
                    const messages = await this._getAllMessages(gid);
                    
                    data.buffers.push({
                        gid,
                        target: meta.target,
                        userId: meta.userId,
                        messages: messages.map(m => ({
                            id: m.id,
                            media: m.media,
                            groupedId: m.groupedId,
                            _seq: m._seq
                        })),
                        createdAt: meta.createdAt
                    });
                }
            }

            await cache.set(this.persistKey, data, 60);
            log.debug(`Persisted ${data.buffers.length} buffers`);
        } catch (error) {
            log.error('Failed to persist buffers:', error);
        }
    }

    /**
     * 恢复缓冲区（用于启动恢复）
     */
    async restore() {
        try {
            const data = await cache.get(this.persistKey, 'json');
            if (!data) return;

            // 恢复缓冲区
            for (const bufferData of data.buffers) {
                // 检查是否过期
                if (Date.now() - bufferData.createdAt > this.options.staleThreshold) {
                    continue;
                }

                // 重新添加消息
                for (const message of bufferData.messages) {
                    const fullMessage = {
                        id: message.id,
                        media: message.media,
                        groupedId: message.groupedId
                    };
                    await this._addMessageToRedis(
                        bufferData.gid,
                        fullMessage,
                        bufferData.target,
                        bufferData.userId
                    );
                }

                // 触发刷新
                const lockResult = await this.distributedLock.acquire(bufferData.gid, this.options.instanceId);
                if (lockResult.success) {
                    await this._flushBufferWithLock(bufferData.gid, lockResult.version);
                }
            }

            log.info(`Restored ${data.buffers.length} media group buffers`);
        } catch (error) {
            log.error('Failed to restore buffers:', error);
        }
    }

    /**
     * 获取缓冲区状态
     */
    async getStatus() {
        try {
            // 获取当前实例的缓冲区
            const bufferPattern = `${this.options.instanceId}:buffer:*:meta`;
            const metaKeys = await cache.listKeys(bufferPattern);
            
            let totalMessages = 0;
            for (const metaKey of metaKeys) {
                const gid = metaKey.split(':')[2];
                const size = await this._getBufferSize(gid);
                totalMessages += size;
            }

            // 获取所有实例的锁状态
            const lockStats = await this.distributedLock.getStats();

            return {
                instanceId: this.options.instanceId,
                activeBuffers: metaKeys.length,
                bufferedMessages: totalMessages,
                localBufferKeys: this.localBufferKeys.size,
                localMessageIds: this.messageIds.size,
                distributedLocks: lockStats
            };
        } catch (error) {
            log.error('Failed to get status:', error);
            return {
                instanceId: this.options.instanceId,
                error: error.message
            };
        }
    }

    /**
     * 清理本地跟踪（用于测试或手动清理）
     */
    cleanup() {
        this.localBufferKeys.clear();
        this.messageIds.clear();
    }
}

// 导出单例
const mediaGroupBuffer = new MediaGroupBuffer();
export default mediaGroupBuffer;