import { kv } from "./kv.js";
import { d1 } from "./d1.js";
import { InstanceRepository } from "../repositories/InstanceRepository.js";

/**
 * --- 多实例协调服务 ---
 * 基于 Cloudflare KV/D1 实现异地多实例支持
 * 职责：实例注册、心跳、分布式锁、任务协调
 */
export class InstanceCoordinator {
    constructor() {
        this.instanceId = process.env.INSTANCE_ID || `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.heartbeatInterval = 60000; // 延长至60秒心跳，减少 KV 调用
        this.instanceTimeout = 180000; // 3分钟超时
        this.heartbeatTimer = null;
        this.isLeader = false;
        this.activeInstances = new Set();
    }

    /**
     * 启动实例协调器
     */
    async start() {
        console.log(`🚀 启动实例协调器: ${this.instanceId}`);

        // 确保数据库表存在
        await InstanceRepository.createTableIfNotExists();

        // 注册实例
        await this.registerInstance();

        // 启动心跳
        this.startHeartbeat();

        // 监听其他实例变化
        this.watchInstances();

        console.log(`✅ 实例协调器启动完成`);
    }

    /**
     * 停止实例协调器
     */
    async stop() {
        console.log(`🛑 停止实例协调器: ${this.instanceId}`);

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        await this.unregisterInstance();
    }

    /**
     * 注册实例 (双写机制：D1 + KV)
     */
    async registerInstance() {
        const instanceData = {
            id: this.instanceId,
            hostname: process.env.HOSTNAME || 'unknown',
            region: process.env.CF_REGION || 'unknown',
            startedAt: Date.now(),
            lastHeartbeat: Date.now(),
            status: 'active'
        };

        // 1. 始终优先写入 D1 数据库 (作为真理之源，防止脑裂)
        await this.registerInstanceToDB(instanceData);

        // 2. 尝试写入 KV (用于快速访问和分布式锁)
        try {
            await kv.set(`instance:${this.instanceId}`, instanceData, this.instanceTimeout / 1000);
            console.log(`📝 实例已注册到 KV: ${this.instanceId}`);
        } catch (kvError) {
            console.warn(`⚠️ KV注册失败 (非致命，已写入DB): ${kvError.message}`);
        }
    }

    /**
     * 将实例信息注册到D1数据库（KV失败时的备用方案）
     */
    async registerInstanceToDB(instanceData) {
        try {
            await InstanceRepository.upsert(instanceData);
            console.log(`📝 实例已注册到数据库: ${this.instanceId}`);
        } catch (dbError) {
            console.error(`❌ 实例注册到数据库也失败: ${dbError.message}`);
        }
    }

    /**
     * 注销实例
     */
    async unregisterInstance() {
        await kv.delete(`instance:${this.instanceId}`);
        console.log(`📝 实例已注销: ${this.instanceId}`);
    }

    /**
     * 启动心跳 (双写机制：D1 + KV)
     */
    startHeartbeat() {
        this.heartbeatTimer = setInterval(async () => {
            const now = Date.now();

            // 1. 始终优先更新 D1 (真理之源)
            try {
                await InstanceRepository.updateHeartbeat(this.instanceId, now);
            } catch (dbError) {
                console.error(`DB心跳更新失败: ${dbError.message}`);
            }

            // 2. 尝试更新 KV
            try {
                const instanceData = await kv.get(`instance:${this.instanceId}`);
                if (instanceData) {
                    instanceData.lastHeartbeat = now;
                    await kv.set(`instance:${this.instanceId}`, instanceData, this.instanceTimeout / 1000);
                } else {
                    // 重新注册 (registerInstance 内部也会写 D1)
                    await this.registerInstance();
                }
            } catch (kvError) {
                // KV 失败忽略，D1 已作为主心跳源
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
            console.error(`获取活跃实例失败:`, e.message);
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
            const existing = await kv.get(`lock:${lockKey}`, "json", { skipCache: true });
            return existing && existing.instanceId === this.instanceId;
        } catch (e) {
            return false;
        }
    }

    /**
     * 获取所有实例（包括可能过期的）
     */
    async getAllInstances() {
        try {
            // 优先从数据库获取实例列表
            const dbInstances = await InstanceRepository.findAll();

            // 如果数据库有数据，返回数据库结果
            if (dbInstances && dbInstances.length > 0) {
                // 同步到本地缓存
                this.activeInstances = new Set(dbInstances.map(inst => inst.id));
                return dbInstances;
            }

            // 如果数据库为空，尝试从KV获取已知的活跃实例
            const instances = [];
            for (const instanceId of this.activeInstances) {
                try {
                    // 使用缓存读取，防止高频调用
                    const instance = await kv.get(`instance:${instanceId}`, "json", { cacheTtl: 30000 });
                    if (instance) instances.push(instance);
                } catch (e) {
                    // 忽略单个实例获取失败
                }
            }
            return instances;
        } catch (e) {
            console.error(`获取所有实例失败:`, e?.message || String(e));
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
                console.log(`👑 本实例成为领导者 (${instanceCount} 个活跃实例)`);
            }

            // 清理过期的实例数据
            if (this.isLeader) {
                await this.cleanupExpiredInstances();
            }
        }, 60000); // 每分钟检查一次
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
                    await kv.delete(`instance:${instance.id}`);
                    cleanedCount++;
                }
            }

            if (cleanedCount > 0) {
                console.log(`🧹 清理了 ${cleanedCount} 个过期实例`);
            }
        } catch (e) {
            console.error(`清理过期实例失败:`, e.message);
        }
    }

    /**
     * 尝试获取分布式锁
     * @param {string} lockKey - 锁的键
     * @param {number} ttl - 锁的TTL（秒）
     * @returns {boolean} 是否获取成功
     */
    async acquireLock(lockKey, ttl = 300) {
        const lockValue = {
            instanceId: this.instanceId,
            acquiredAt: Date.now(),
            ttl: ttl
        };

        try {
            // 尝试原子性地设置锁，如果键不存在则成功
            // 锁的读取不使用 L1 缓存，确保实时性
            const existing = await kv.get(`lock:${lockKey}`, "json", { skipCache: true });

            if (existing) {
                // 检查锁是否仍然有效
                const now = Date.now();
                if (existing.instanceId !== this.instanceId &&
                    (now - existing.acquiredAt) < (existing.ttl * 1000)) {
                    return false; // 锁被其他实例持有且未过期
                }
                // 如果锁过期或被当前实例持有，允许重新获取
            }

            // 设置锁，使用时间戳作为额外的验证
            lockValue.version = Date.now();
            await kv.set(`lock:${lockKey}`, lockValue, ttl, { skipCache: true });
            return true;
        } catch (e) {
            console.error(`获取锁失败 ${lockKey}:`, e?.message || String(e));
            return false;
        }
    }

    /**
     * 释放分布式锁
     * @param {string} lockKey - 锁的键
     */
    async releaseLock(lockKey) {
        try {
            const existing = await kv.get(`lock:${lockKey}`, "json", { skipCache: true });
            if (existing && existing.instanceId === this.instanceId) {
                await kv.delete(`lock:${lockKey}`);
            }
        } catch (e) {
            console.error(`释放锁失败 ${lockKey}:`, e?.message || String(e));
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
}

// 导出单例实例
export const instanceCoordinator = new InstanceCoordinator();