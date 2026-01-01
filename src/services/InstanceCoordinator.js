import { cache } from "./CacheService.js";
import { d1 } from "./d1.js";
import { qstashService } from "./QStashService.js";
import { InstanceRepository } from "../repositories/InstanceRepository.js";
import logger, { setInstanceIdProvider } from "./logger.js";

/**
 * --- 多实例协调服务 ---
 * 基于 Cloudflare Cache 实现异地多实例支持
 * 职责：实例注册、心跳、分布式锁、任务协调
 */
export class InstanceCoordinator {
    constructor() {
        this.instanceId = process.env.INSTANCE_ID || `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Register this instance as the ID provider for the logger
        setInstanceIdProvider(() => this.instanceId);
        this.nodeType = process.env.NODE_MODE || 'bot';
        this.heartbeatInterval = 5 * 60 * 1000; // 进一步延长至 5 分钟心跳，大幅减少 KV 调用 (因为 Cloudflare KV 免费额度有限)
        this.instanceTimeout = 15 * 60 * 1000; // 15分钟超时
        this.heartbeatTimer = null;
        this.isLeader = false;
        this.activeInstances = new Set();
    }

    /**
     * 启动实例协调器
     */
    async start() {
        logger.info(`🚀 启动实例协调器: ${this.instanceId}`);

        // 注册实例
        await this.registerInstance();

        // 启动心跳
        this.startHeartbeat();

        // 监听其他实例变化
        this.watchInstances();

        logger.info(`✅ 实例协调器启动完成`);
    }

    /**
     * 停止实例协调器
     */
    async stop() {
        logger.info(`🛑 停止实例协调器: ${this.instanceId}`);

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        await this.unregisterInstance();
    }

    /**
     * 注册实例 (Cache 存储，符合低频关键数据规则)
     */
    async registerInstance() {
        const instanceData = {
            id: this.instanceId,
            url: process.env.APP_EXTERNAL_URL, // 新增：外部可访问的 URL，用于 LB 转发
            hostname: process.env.HOSTNAME || 'unknown',
            region: process.env.CF_REGION || 'unknown',
            startedAt: Date.now(),
            lastHeartbeat: Date.now(),
            status: 'active'
        };

        // 写入 Cache (核心 Cache 模块，用于关键数据存储)
        try {
            await cache.set(`instance:${this.instanceId}`, instanceData, this.instanceTimeout / 1000);
            logger.info(`[${cache.getCurrentProvider()}] 📝 实例已注册到 Cache: ${this.instanceId}`);
        } catch (cacheError) {
            logger.error(`[${cache.getCurrentProvider()}] ❌ Cache注册失败: ${cacheError.message}`);
            throw cacheError; // Cache 是主存储，失败时抛出异常
        }
    }

    /**
     * 注销实例
     */
    async unregisterInstance() {
        await cache.delete(`instance:${this.instanceId}`);
        logger.info(`[${cache.getCurrentProvider()}] 📝 实例已注销: ${this.instanceId}`);
    }

    /**
     * 启动心跳 (KV 存储，符合低频关键数据规则)
     */
    startHeartbeat() {
        this.heartbeatTimer = setInterval(async () => {
            const now = Date.now();

            try {
                // 检查实例是否仍然存在于 Cache 中
                const existing = await cache.get(`instance:${this.instanceId}`);
                if (!existing) {
                    // 实例不存在，重新注册
                    await this.registerInstance();
                } else {
                    // 实例存在，更新心跳
                    const instanceData = {
                        ...existing,
                        lastHeartbeat: now,
                        status: 'active'
                    };
                    await cache.set(`instance:${this.instanceId}`, instanceData, this.instanceTimeout / 1000);
                }
            } catch (cacheError) {
                logger.error(`[${cache.getCurrentProvider()}] Cache心跳更新失败: ${cacheError.message}`);
            }
        }, this.heartbeatInterval);
    }

    /**
     * 获取活跃实例列表
     */
    async getActiveInstances() {
        try {
            // 获取所有实例键
            const allInstances = await this.getAllInstances();
            const now = Date.now();
            const activeInstances = [];

            for (const instance of allInstances) {
                if (instance.lastHeartbeat && (now - instance.lastHeartbeat) < this.instanceTimeout) {
                    activeInstances.push(instance);
                }
            }

            this.activeInstances = new Set(activeInstances.map(inst => inst.id));
            return activeInstances;
        } catch (e) {
            logger.error(`[${cache.getCurrentProvider()}] 获取活跃实例失败:`, e.message);
            return [];
        }
    }

    /**
     * 检查当前实例是否持有特定的锁
     * @param {string} lockKey - 锁的键
     * @returns {boolean}
     */
    async hasLock(lockKey) {
        try {
            const existing = await cache.get(`lock:${lockKey}`, "json", { skipCache: true });
            const isOwner = existing && existing.instanceId === this.instanceId;
            if (existing && !isOwner) {
                // 明确被其他实例持有
                // logger.debug(`[Lock] ${lockKey} is held by ${existing.instanceId}`);
            }
            return isOwner;
        } catch (e) {
            // 关键：识别 KV 错误，不要在 429 或网络错误时立即断定失去锁
            logger.warn(`[${cache.getCurrentProvider()}] ⚠️ 检查锁失败 ${lockKey}, 可能是 KV 限流或网络问题: ${e.message}`);
            
            // 如果是 429 或超时，保守起见我们假设仍然持有（只要上一次成功持有）
            // 或者抛出错误让调用者决定，而不是返回错误的 false
            if (e.message.includes("429") || e.message.includes("limit") || e.message.includes("fetch")) {
                // 这里暂时抛出异常，让 handleConnectionIssue 等地方感知到是 "检查失败" 而不是 "锁丢失"
                throw e; 
            }
            return false;
        }
    }

    /**
     * 获取所有实例（主动发现所有 instance: 前缀的键）
     */
    async getAllInstances() {
        try {
            // 使用 listKeys 主动发现所有实例键
            const instanceKeys = await cache.listKeys('instance:');
            const instances = [];

            for (const key of instanceKeys) {
                try {
                    // 从键名中提取实例ID
                    const instanceId = key.replace('instance:', '');
                    // 获取实例数据，使用缓存防止高频调用
                    const instance = await cache.get(key, "json", { cacheTtl: 30000 });
                    if (instance) {
                        // 确保实例数据包含 id 字段
                        instances.push({
                            id: instanceId, // 确保 ID 一致
                            ...instance
                        });
                    }
                } catch (e) {
                    logger.warn(`[${cache.getCurrentProvider()}] 获取实例 ${key} 失败，跳过:`, e?.message || String(e));
                    // 忽略单个实例获取失败，继续处理其他实例
                }
            }

            // 更新活跃实例集合（用于向后兼容）
            this.activeInstances = new Set(instances.map(inst => inst.id));
            return instances;
        } catch (e) {
            logger.error(`[${cache.getCurrentProvider()}] 获取所有实例失败:`, e?.message || String(e));
            return [];
        }
    }

    /**
     * 监听实例变化
     */
    async watchInstances() {
        // 定期检查实例变化
        setInterval(async () => {
            const activeInstances = await this.getActiveInstances();
            const instanceCount = activeInstances.length;

            // 选举领导者（ID 最小的实例）
            const sortedInstances = activeInstances.sort((a, b) => a.id.localeCompare(b.id));
            const leader = sortedInstances[0];

            this.isLeader = leader && leader.id === this.instanceId;

            if (this.isLeader) {
                logger.info(`👑 本实例成为领导者 (${instanceCount} 个活跃实例)`);
            }

            // 清理过期的实例数据
            if (this.isLeader) {
                await this.cleanupExpiredInstances();
            }
        }, 5 * 60 * 1000); // 延长至 5 分钟检查一次，与心跳频率对齐，减少 KV 读消耗
    }

    /**
     * 清理过期实例（仅领导者执行）
     */
    async cleanupExpiredInstances() {
        try {
            const allInstances = await this.getAllInstances();
            const now = Date.now();
            let cleanedCount = 0;

            for (const instance of allInstances) {
                if ((now - instance.lastHeartbeat) > this.instanceTimeout * 2) {
                    await cache.delete(`instance:${instance.id}`);
                    cleanedCount++;
                }
            }

            if (cleanedCount > 0) {
                logger.info(`[${cache.getCurrentProvider()}] 🧹 清理了 ${cleanedCount} 个过期实例`);
            }
        } catch (e) {
            logger.error(`[${cache.getCurrentProvider()}] 清理过期实例失败:`, e.message);
        }
    }

    /**
      * 尝试获取分布式锁（带重试逻辑）
      * @param {string} lockKey - 锁的键
      * @param {number} ttl - 锁的TTL（秒）
      * @param {Object} options - 配置选项
      * @param {number} options.maxAttempts - 最大重试次数
      * @returns {boolean} 是否获取成功
      */
    async acquireLock(lockKey, ttl = 300, options = {}) {
        const maxAttempts = options.maxAttempts || 3;
        const backoffDelays = [100, 500, 1000, 2000, 5000]; // 指数退避延迟

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const success = await this._tryAcquire(lockKey, ttl);
            if (success) {
                return true;
            }

            // 如果不是最后一次尝试，等待退避延迟
            if (attempt < maxAttempts) {
                const delay = backoffDelays[Math.min(attempt - 1, backoffDelays.length - 1)];
                logger.warn(`[${cache.getCurrentProvider()}] 🔒 锁获取失败，尝试 ${attempt}/${maxAttempts}，等待 ${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        logger.error(`[${cache.getCurrentProvider()}] 🔒 锁获取失败，已达到最大重试次数: ${lockKey}`);
        return false;
    }

    /**
     * 内部方法：单次尝试获取锁
     * @param {string} lockKey - 锁的键
     * @param {number} ttl - 锁的TTL（秒）
     * @returns {boolean} 是否获取成功
     */
    async _tryAcquire(lockKey, ttl) {
        const lockValue = {
            instanceId: this.instanceId,
            acquiredAt: Date.now(),
            ttl: ttl
        };

        try {
            // 尝试原子性地设置锁，如果键不存在则成功
            // 锁的读取不使用 L1 缓存，确保实时性
            const existing = await cache.get(`lock:${lockKey}`, "json", { skipCache: true });

            if (existing) {
                // 检查锁是否仍然有效
                const now = Date.now();
                if (existing.instanceId !== this.instanceId &&
                    (now - existing.acquiredAt) < (existing.ttl * 1000)) {
                    
                    // 检查锁持有者是否真的活跃（抢占逻辑）
                    const ownerKey = `instance:${existing.instanceId}`;
                    const ownerData = await cache.get(ownerKey, "json", { skipCache: true });
                    
                    if (ownerData) {
                        // 锁被其他活跃实例持有且未过期
                        // logger.debug(`[Lock] ${lockKey} is held by active instance ${existing.instanceId}`);
                        return false;
                    }
                    
                    // 锁持有者已下线，允许抢占
                    logger.info(`[${cache.getCurrentProvider()}] 🔒 发现残留锁 ${lockKey} (持有者 ${existing.instanceId} 已下线)，允许抢占`);
                }
                // 如果锁过期、被当前实例持有、或持有者已下线，允许重新获取
            }

            // 设置锁
            // 注意：移除 version 字段以解决 Cloudflare KV 最终一致性导致的 verify 失败问题
            // 在续租场景下，即使读到旧值，只要 instanceId 匹配即认为成功
            await cache.set(`lock:${lockKey}`, lockValue, ttl, { skipCache: true });
            
            // 双重校验：写入后验证是否确实是自己的锁
            const verified = await cache.get(`lock:${lockKey}`, "json", { skipCache: true });
            
            // 记录详细日志便于排查 KV 延迟问题
            logger.debug(`[${cache.getCurrentProvider()}] [Lock verify] key=${lockKey}, existing=${existing?.instanceId}, verified=${verified?.instanceId}, self=${this.instanceId}`);

            if (verified && verified.instanceId === this.instanceId) {
                return true;
            }
            
            // 被其他实例抢先覆盖了
            return false;
        } catch (e) {
            logger.error(`[${cache.getCurrentProvider()}] 获取锁失败 ${lockKey}:`, e?.message || String(e));
            return false;
        }
    }

    /**
     * 释放分布式锁
     * @param {string} lockKey - 锁的键
     */
    async releaseLock(lockKey) {
        try {
            const existing = await cache.get(`lock:${lockKey}`, "json", { skipCache: true });
            if (existing && existing.instanceId === this.instanceId) {
                await cache.delete(`lock:${lockKey}`);
            }
        } catch (e) {
            logger.error(`[${cache.getCurrentProvider()}] 释放锁失败 ${lockKey}:`, e?.message || String(e));
        }
    }

    /**
     * 尝试获取任务锁
     * @param {string} taskId - 任务ID
     * @returns {boolean} 是否获取成功
     */
    async acquireTaskLock(taskId) {
        return await this.acquireLock(`task:${taskId}`, 600); // 10分钟TTL
    }

    /**
     * 释放任务锁
     * @param {string} taskId - 任务ID
     */
    async releaseTaskLock(taskId) {
        await this.releaseLock(`task:${taskId}`);
    }

    /**
     * 检查实例是否为领导者
     */
    isLeader() {
        return this.isLeader;
    }

    /**
     * 获取实例ID
     */
    getInstanceId() {
        return this.instanceId;
    }

    /**
     * 获取活跃实例数量
     */
    async getInstanceCount() {
        const activeInstances = await this.getActiveInstances();
        return activeInstances.length;
    }

    /**
     * 广播系统事件到所有实例 (使用 QStash Topics)
     * @param {string} event - 事件名称
     * @param {object} data - 事件数据
     */
    async broadcast(event, data = {}) {
        try {
            await qstashService.broadcastSystemEvent(event, {
                ...data,
                sourceInstance: this.instanceId,
                timestamp: Date.now()
            });
            logger.info(`[${cache.getCurrentProvider()}] 📢 广播系统事件: ${event}`);
        } catch (error) {
            logger.error(`[${cache.getCurrentProvider()}] ❌ 广播事件失败 ${event}:`, error);
        }
    }
}

// 导出单例实例
export const instanceCoordinator = new InstanceCoordinator();

// 导出获取实例 ID 的函数
export const getInstanceId = () => instanceCoordinator.instanceId;

// 默认导出
export default instanceCoordinator;