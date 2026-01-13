import { logger } from "./logger/index.js";
import { cache } from "./CacheService.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { queueService } from "./QueueService.js";
import { localCache } from "../utils/LocalCache.js";

const log = logger.withModule('StateSynchronizer');

/**
 * 状态同步器服务
 * 职责：
 * 1. 跨实例状态同步
 * 2. 分布式事件处理
 * 3. 状态一致性保证
 */
export class StateSynchronizer {
    constructor() {
        this.syncPrefix = 'sync:';
        this.statePrefix = 'state:';
        this.subscribers = new Map();
        this.syncInterval = 5000; // 5秒同步一次
        this.syncTimer = null;
    }

    /**
     * 初始化状态同步器
     */
    async init() {
        log.info('Initializing StateSynchronizer...');
        
        // 启动定期同步
        this.syncTimer = setInterval(() => {
            this._periodicSync().catch(error => {
                log.error('Periodic sync failed:', error);
            });
        }, this.syncInterval);

        // 订阅队列事件
        await this._subscribeToEvents();
        
        log.info('StateSynchronizer initialized');
    }

    /**
     * 停止状态同步器
     */
    async stop() {
        log.info('Stopping StateSynchronizer...');
        
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        // 取消所有订阅
        this.subscribers.clear();
        
        log.info('StateSynchronizer stopped');
    }

    /**
     * 同步指定用户的状态
     * @param {string} userId - 用户ID
     * @param {string} stateType - 状态类型
     * @returns {Promise<boolean>} 是否成功
     */
    async syncUserState(userId, stateType) {
        const lockName = `sync_state:${userId}:${stateType}`;
        const acquired = await instanceCoordinator.acquireLock(lockName, 30);
        
        if (!acquired) {
            log.warn(`Failed to acquire lock for state sync: ${lockName}`);
            return false;
        }

        try {
            // 1. 获取当前实例的状态
            const localState = await this._getLocalState(userId, stateType);
            
            // 2. 获取其他实例的状态
            const remoteStates = await this._getRemoteStates(userId, stateType);
            
            // 3. 合并状态
            const mergedState = this._mergeStates(localState, remoteStates);
            
            // 4. 广播合并后的状态
            await this._broadcastState(userId, stateType, mergedState);
            
            // 5. 更新本地状态
            await this._setLocalState(userId, stateType, mergedState);
            
            log.debug(`State synchronized for user ${userId}, type: ${stateType}`);
            return true;
        } catch (error) {
            log.error(`State sync failed for user ${userId}:`, error);
            return false;
        } finally {
            await instanceCoordinator.releaseLock(lockName);
        }
    }

    /**
     * 发布状态变更事件
     * @param {string} userId - 用户ID
     * @param {string} stateType - 状态类型
     * @param {*} state - 新状态
     * @param {string} source - 来源实例ID
     */
    async publishStateChange(userId, stateType, state, source = null) {
        const event = {
            type: 'state_change',
            userId,
            stateType,
            state,
            source: source || instanceCoordinator.getInstanceId(),
            timestamp: Date.now(),
            sequence: Date.now()
        };

        try {
            // 通过队列广播
            await queueService.publish('state_sync', event);
            
            // 同时存储到缓存供其他实例拉取
            const cacheKey = `${this.syncPrefix}${userId}:${stateType}`;
            await cache.set(cacheKey, state, 300); // 5分钟TTL
            
            log.debug(`Published state change for user ${userId}, type: ${stateType}`);
        } catch (error) {
            log.error('Failed to publish state change:', error);
            throw error;
        }
    }

    /**
     * 订阅状态变更事件
     * @param {string} stateType - 状态类型
     * @param {Function} callback - 回调函数
     * @returns {string} 订阅ID
     */
    subscribe(stateType, callback) {
        const subscriptionId = `${stateType}:${Date.now()}:${Math.random()}`;
        
        if (!this.subscribers.has(stateType)) {
            this.subscribers.set(stateType, new Map());
        }
        
        this.subscribers.get(stateType).set(subscriptionId, callback);
        
        log.debug(`Subscribed to state type: ${stateType}, id: ${subscriptionId}`);
        return subscriptionId;
    }

    /**
     * 取消订阅
     * @param {string} subscriptionId - 订阅ID
     */
    unsubscribe(subscriptionId) {
        for (const [stateType, callbacks] of this.subscribers.entries()) {
            if (callbacks.has(subscriptionId)) {
                callbacks.delete(subscriptionId);
                log.debug(`Unsubscribed: ${subscriptionId}`);
                return;
            }
        }
    }

    /**
     * 获取状态快照
     * @param {string} userId - 用户ID
     * @param {string} stateType - 状态类型
     * @returns {Promise<*>} 状态快照
     */
    async getStateSnapshot(userId, stateType) {
        const cacheKey = `${this.statePrefix}${userId}:${stateType}`;
        
        // 1. 尝试从本地缓存获取
        const local = localCache.get(cacheKey);
        if (local !== undefined) {
            return local;
        }

        // 2. 从分布式缓存获取
        try {
            const state = await cache.get(cacheKey);
            if (state !== null) {
                localCache.set(cacheKey, state, 60);
                return state;
            }
        } catch (error) {
            log.warn(`Failed to get state snapshot for ${userId}:`, error);
        }

        return null;
    }

    /**
     * 恢复状态快照
     * @param {string} userId - 用户ID
     * @param {string} stateType - 状态类型
     * @param {*} snapshot - 快照数据
     */
    async restoreStateSnapshot(userId, stateType, snapshot) {
        const cacheKey = `${this.statePrefix}${userId}:${stateType}`;
        
        try {
            // 1. 恢复到分布式缓存
            await cache.set(cacheKey, snapshot, 3600);
            
            // 2. 恢复到本地缓存
            localCache.set(cacheKey, snapshot, 60);
            
            // 3. 发布恢复事件
            await this.publishStateChange(userId, stateType, snapshot);
            
            log.info(`State snapshot restored for user ${userId}, type: ${stateType}`);
            return true;
        } catch (error) {
            log.error(`Failed to restore state snapshot for ${userId}:`, error);
            return false;
        }
    }

    /**
     * 处理来自队列的同步事件
     * @param {Object} event - 同步事件
     */
    async handleSyncEvent(event) {
        if (event.source === instanceCoordinator.getInstanceId()) {
            return; // 忽略自己的事件
        }

        const { userId, stateType, state } = event;

        // 1. 更新本地缓存
        const cacheKey = `${this.statePrefix}${userId}:${stateType}`;
        localCache.set(cacheKey, state, 60);

        // 2. 通知订阅者
        const callbacks = this.subscribers.get(stateType);
        if (callbacks) {
            for (const [subId, callback] of callbacks.entries()) {
                try {
                    await callback(userId, state, event);
                } catch (error) {
                    log.error(`Subscriber ${subId} callback failed:`, error);
                }
            }
        }

        log.debug(`Handled sync event for user ${userId}, type: ${stateType}`);
    }

    /**
     * 定期同步（用于故障恢复）
     * @private
     */
    async _periodicSync() {
        const activeUsers = await this._getActiveUsers();
        
        for (const userId of activeUsers) {
            const stateTypes = ['tasks', 'drives', 'sessions'];
            
            for (const stateType of stateTypes) {
                await this.syncUserState(userId, stateType);
            }
        }
    }

    /**
     * 订阅队列事件
     * @private
     */
    async _subscribeToEvents() {
        try {
            await queueService.subscribe('state_sync', async (event) => {
                await this.handleSyncEvent(event);
            });
            
            log.info('Subscribed to state_sync queue');
        } catch (error) {
            log.error('Failed to subscribe to state_sync queue:', error);
        }
    }

    /**
     * 获取本地状态
     * @private
     */
    async _getLocalState(userId, stateType) {
        const cacheKey = `${this.statePrefix}${userId}:${stateType}`;
        
        // 从本地缓存或数据库获取
        const local = localCache.get(cacheKey);
        if (local !== undefined) {
            return local;
        }

        // 从分布式缓存获取
        const state = await cache.get(cacheKey);
        if (state !== null) {
            localCache.set(cacheKey, state, 60);
            return state;
        }

        return null;
    }

    /**
     * 获取远程状态
     * @private
     */
    async _getRemoteStates(userId, stateType) {
        const remoteStates = [];
        const activeInstances = await instanceCoordinator.getActiveInstances();
        
        for (const instanceId of activeInstances) {
            if (instanceId === instanceCoordinator.getInstanceId()) {
                continue;
            }

            const cacheKey = `${this.syncPrefix}${userId}:${stateType}:${instanceId}`;
            try {
                const state = await cache.get(cacheKey);
                if (state !== null) {
                    remoteStates.push({ instanceId, state });
                }
            } catch (error) {
                log.warn(`Failed to get remote state from ${instanceId}:`, error);
            }
        }

        return remoteStates;
    }

    /**
     * 合并状态
     * @private
     */
    _mergeStates(localState, remoteStates) {
        if (remoteStates.length === 0) {
            return localState;
        }

        // 简单的合并策略：取最新的时间戳
        let merged = localState;
        let maxTimestamp = 0;

        // 检查本地状态
        if (localState && localState.timestamp) {
            maxTimestamp = localState.timestamp;
        }

        // 检查远程状态
        for (const { instanceId, state } of remoteStates) {
            if (state && state.timestamp && state.timestamp > maxTimestamp) {
                merged = state;
                maxTimestamp = state.timestamp;
            }
        }

        return merged;
    }

    /**
     * 广播状态
     * @private
     */
    async _broadcastState(userId, stateType, state) {
        await this.publishStateChange(userId, stateType, state);
    }

    /**
     * 设置本地状态
     * @private
     */
    async _setLocalState(userId, stateType, state) {
        const cacheKey = `${this.statePrefix}${userId}:${stateType}`;
        
        // 更新分布式缓存
        await cache.set(cacheKey, state, 3600);
        
        // 更新本地缓存
        localCache.set(cacheKey, state, 60);
    }

    /**
     * 获取活跃用户列表
     * @private
     */
    async _getActiveUsers() {
        try {
            // 从缓存获取最近活跃的用户
            const activeUsersKey = 'active_users';
            const users = await cache.get(activeUsersKey);
            return users || [];
        } catch (error) {
            log.warn('Failed to get active users:', error);
            return [];
        }
    }

    /**
     * 添加活跃用户
     * @param {string} userId - 用户ID
     */
    async addActiveUser(userId) {
        try {
            const activeUsersKey = 'active_users';
            const users = await cache.get(activeUsersKey) || [];
            
            if (!users.includes(userId)) {
                users.push(userId);
                await cache.set(activeUsersKey, users, 3600);
            }
        } catch (error) {
            log.warn(`Failed to add active user ${userId}:`, error);
        }
    }

    /**
     * 获取同步统计信息
     */
    async getStats() {
        return {
            subscribers: Array.from(this.subscribers.entries()).map(([type, callbacks]) => ({
                type,
                count: callbacks.size
            })),
            syncInterval: this.syncInterval,
            instanceId: instanceCoordinator.getInstanceId()
        };
    }
}

// 单例导出
export const stateSynchronizer = new StateSynchronizer();