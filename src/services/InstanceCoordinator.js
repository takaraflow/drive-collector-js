import { cache } from "./CacheService.js";
import { queueService } from "./QueueService.js";
import { InstanceRepository } from "../repositories/InstanceRepository.js";
import logger, { setInstanceIdProvider } from "./logger/index.js";
import { setInstanceIdProvider as setAxiomInstanceIdProvider } from "./logger/AxiomLogger.js";

const log = logger.withModule('InstanceCoordinator');

// 创建带 provider 上下文的 logger 用于动态 provider 信息
const logWithProvider = () => log.withContext({ provider: cache.getCurrentProvider() });

/**
 * --- 多实例协调服务 ---
 * 基于分布式缓存实现异地多实例支持
 * 职责：实例注册、心跳、分布式锁、任务协调
 */
export class InstanceCoordinator {
    constructor() {
        // 增强实例 ID 生成：确保唯一性，防止多进程冲突
        // 如果是多进程环境，使用 PID + 时间戳 + 随机数
        const pid = process.pid || 'unknown';
        const timestamp = Date.now();
        const random = Math.random().toString(36).substr(2, 9);
        const hostname = process.env.HOSTNAME || 'unknown';
        
        this.instanceId = process.env.INSTANCE_ID || `instance_${hostname}_${pid}_${timestamp}_${random}`;
        
        // Register this instance as the ID provider for logger
        setInstanceIdProvider(() => this.instanceId);
        // Also register for AxiomLogger
        setAxiomInstanceIdProvider(() => this.instanceId);
        this.nodeType = process.env.NODE_MODE || 'bot';
        
        // 动态调整心跳：根据实例数量优化 KV 写入频率
        // 少于 50 实例：30秒，50-200：60秒，超过 200：120秒
        this.heartbeatInterval = 30 * 1000;  // 默认 30 秒
        this.instanceTimeout = 90 * 1000;  // 90 秒超时（3个心跳周期）
        this.heartbeatTimer = null;
        this.lockRenewalTimer = null;  // 新增：锁续租定时器
        this.isLeader = false;
        this.activeInstances = new Set();

        // Active task counter (optional, set by lifecycle/TaskManager)
        this.activeTaskCount = 0;
        this.getActiveTaskCountFn = null;
        
        // 延迟调整定时器（启动后 30 秒再检查实例数量并调整）
        this.heartbeatAdjustTimer = null;
        
        log.info(`🔧 实例 ID 生成: ${this.instanceId} (PID: ${pid}, Host: ${hostname})`);
    }

    /**
     * 启动实例协调器
     */
    async start() {
        log.info(`🚀 启动实例协调器: ${this.instanceId}`);

        // 注册实例
        await this.registerInstance();

        // 自检：枚举实例键，确认外部缓存可用
        try {
            const keys = await cache.listKeys('instance:');
            logWithProvider().info(`实例键自检: ${keys.length} 个`);
        } catch (error) {
            logWithProvider().warn(`实例键自检失败: ${error.message}`);
        }

        // 启动心跳
        this.startHeartbeat();
        
        // 启动心跳调整（30秒后根据实例数量动态调整）
        this.startHeartbeatAdjustment();
        
        // 监听其他实例变化
        this.watchInstances();
        
        log.info(`✅ 实例协调器启动完成`);
    }

    /**
     * 停止实例协调器
     */
    async stop() {
        log.info(`🛑 停止实例协调器: ${this.instanceId}`);
        
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        // 清理锁续租定时器
        if (this.lockRenewalTimer) {
            clearInterval(this.lockRenewalTimer);
            this.lockRenewalTimer = null;
        }
        
        // 清理心跳调整定时器
        if (this.heartbeatAdjustTimer) {
            clearInterval(this.heartbeatAdjustTimer);
            this.heartbeatAdjustTimer = null;
        }

        await this.unregisterInstance();
    }

    /**
     * 注册实例 (Cache 存储，符合低频关键数据规则)
     */
    async registerInstance() {
        const now = Date.now();
        const instanceData = {
            id: this.instanceId,
            url: process.env.APP_EXTERNAL_URL, // 新增：外部可访问的 URL，用于 LB 转发
            hostname: process.env.HOSTNAME || 'unknown',
            region: process.env.INSTANCE_REGION || 'unknown',
            startedAt: now,
            lastHeartbeat: now,
            status: 'active',
            activeTaskCount: this.getLocalActiveTaskCount(),
            timeoutMs: this.instanceTimeout
        };

        // 使用 InstanceRepository 进行注册
        try {
            await InstanceRepository.upsert(instanceData);
            logWithProvider().info(`📝 实例已注册到 Cache: ${cache.getCurrentProvider()}`);
        } catch (error) {
            logWithProvider().error(`❌ 实例注册失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 注销实例
     */
    async unregisterInstance() {
        try {
            await InstanceRepository.markOffline(this.instanceId);
            logWithProvider().info(`📝 实例已注销: ${this.instanceId}`);
        } catch (error) {
            logWithProvider().error(`❌ 实例注销失败: ${error.message}`);
        }
    }

    /**
     * 启动心跳
     */
    async startHeartbeat() {
        logWithProvider().debug(`启动心跳，当前间隔: ${this.heartbeatInterval / 1000}s`);
        
        // 独立的锁续租逻辑 - 不会被其他操作阻塞
        const startLockRenewal = () => {
            // 立即执行一次，然后按间隔重复
            const renew = async () => {
                try {
                    // 检查当前是否持有锁
                    const hasLock = await this.hasLock("telegram_client");
                    if (hasLock) {
                        // 续租锁
                        const lockData = await cache.get(`lock:telegram_client`, "json", { skipCache: true });
                        if (lockData && lockData.instanceId === this.instanceId) {
                            // 更新锁的 TTL
                            await cache.set(`lock:telegram_client`, {
                                ...lockData,
                                acquiredAt: Date.now() // 更新获取时间，相当于续租
                            }, 300, { skipCache: true });
                            logWithProvider().debug(`🔒 锁续租成功`);
                        }
                    }
                } catch (e) {
                    logWithProvider().warn(`🔒 锁续租失败: ${e.message}`);
                }
            };
            
            // 立即执行一次
            renew();
            
            // 每 30 秒续租一次（锁 TTL 为 300 秒，提前续租）
            return setInterval(renew, 30000);
        };
        
        // 启动锁续租定时器（独立于心跳）
        this.lockRenewalTimer = startLockRenewal();
        
        // 原有的心跳逻辑（仅负责实例注册）
        this.heartbeatTimer = setInterval(async () => {
            try {
                // 检查并更新心跳
                const existing = await InstanceRepository.findById(this.instanceId);
                if (!existing) {
                    await this.registerInstance();
                } else {
                    const instanceData = {
                        ...existing,
                        lastHeartbeat: Date.now(),
                        activeTaskCount: this.getLocalActiveTaskCount(),
                        timeoutMs: this.instanceTimeout
                    };
                    await InstanceRepository.upsert(instanceData);
                }
            } catch (error) {
                logWithProvider().error(`心跳更新失败: ${error.message}`);
            }
        }, this.heartbeatInterval);
    }

    /**
     * Register a function that returns the current active task count for this instance.
     * The function should be synchronous and fast.
     * @param {() => number} getActiveTaskCountFn
     */
    registerActiveTaskCounter(getActiveTaskCountFn) {
        this.getActiveTaskCountFn = getActiveTaskCountFn;
    }

    /**
     * Set local active task count (fallback when no counter function is registered).
     * @param {number} count
     */
    setActiveTaskCount(count) {
        const parsed = Number.parseInt(count, 10);
        if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return;
        this.activeTaskCount = Math.max(0, parsed);
    }

    /**
     * Get current active task count from registered function or local value.
     * @returns {number}
     */
    getLocalActiveTaskCount() {
        try {
            if (typeof this.getActiveTaskCountFn === 'function') {
                const value = this.getActiveTaskCountFn();
                const parsed = Number.parseInt(value, 10);
                if (Number.isFinite(parsed) && !Number.isNaN(parsed)) {
                    this.activeTaskCount = Math.max(0, parsed);
                }
            }
        } catch (e) {
            // Ignore counter errors and keep last known value
        }
        return this.activeTaskCount;
    }

    /**
     * 获取活跃实例列表
     */
    async getActiveInstances() {
        try {
            const activeInstances = await InstanceRepository.findAllActive(this.instanceTimeout);
            this.activeInstances = new Set(activeInstances.map(inst => inst.id));
            return activeInstances;
        } catch (e) {
            logWithProvider().error(`获取活跃实例失败:`, e.message);
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
                log.warn(`[Lock] ${lockKey} is held by ${existing.instanceId} (self: ${this.instanceId})`);
            } else if (!existing) {
                log.warn(`[Lock] ${lockKey} is NOT held by anyone (expired or never acquired)`);
            }
            return isOwner;
        } catch (e) {
            // 关键：识别 KV 错误，不要在 429 或网络错误时立即断定失去锁
            logWithProvider().warn(`⚠️ 检查锁失败 ${lockKey}, 可能是 KV 限流或网络问题: ${e.message}`);
            
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
            const instances = await InstanceRepository.findAll();
            this.activeInstances = new Set(instances.map(inst => inst.id));
            return instances;
        } catch (e) {
            logWithProvider().error(`获取所有实例失败:`, e?.message || String(e));
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
                log.info(`👑 本实例成为领导者 (${instanceCount} 个活跃实例)`);
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
            const cleanedCount = await InstanceRepository.deleteExpired(this.instanceTimeout * 2);
            if (cleanedCount > 0) {
                logWithProvider().info(`🧹 清理了 ${cleanedCount} 个过期实例`);
            }
        } catch (e) {
            logWithProvider().error(`清理过期实例失败:`, e.message);
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
                // Reduce noise: keep retry attempts at debug level
                logWithProvider().debug(`🔒 锁获取失败，尝试 ${attempt}/${maxAttempts}，等待 ${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        logWithProvider().warn(`🔒 锁获取失败，已达到最大重试次数: ${lockKey}`);
        return false;
    }

    /**
     * 发送心跳
     */
    async _sendHeartbeat() {
        try {
            await this.registerInstance();
        } catch (e) {
            logWithProvider().error(`Cache心跳更新失败: ${e.message}`);
        }
    }

    /**
     * 启动心跳间隔动态调整
     * 30 秒后检查实例数量并调整心跳间隔以优化 KV 写入频率
     */
    startHeartbeatAdjustment() {
        // 30 秒后首次检查实例数量并调整
        setTimeout(async () => {
            const adjust = async () => {
                try {
                    const instanceCount = await this.getInstanceCount();
                    const newInterval = instanceCount > 200 ? 60 * 1000 : 30 * 1000;
                    
                    if (newInterval !== this.heartbeatInterval) {
                        log.info(`[HeartbeatAdjust] 调整心跳间隔: ${this.heartbeatInterval / 1000}s → ${newInterval / 1000}s (实例数: ${instanceCount})`);
                        
                        // 停止旧定时器并启动新的
                        if (this.heartbeatTimer) {
                            clearInterval(this.heartbeatTimer);
                        }
                        
                        this.heartbeatInterval = newInterval;
                        this.startHeartbeat();
                    }
                } catch (error) {
                    log.error(`[HeartbeatAdjust] 调整失败:`, error);
                }
            };
            
            await adjust();
            
            // 之后每 5 分钟检查一次
            this.heartbeatAdjustTimer = setInterval(adjust, 5 * 60 * 1000);
        }, 30 * 1000);
    }

    /**
     * 停止心跳
     */
    async stopHeartbeat() {
        logWithProvider().debug(`停止心跳`);
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.lockRenewalTimer) {
            clearInterval(this.lockRenewalTimer);
            this.lockRenewalTimer = null;
        }
        if (this.heartbeatAdjustTimer) {
            clearInterval(this.heartbeatAdjustTimer);
            this.heartbeatAdjustTimer = null;
        }
    }

    /**
     * 停止心跳间隔动态调整
     */
    stopHeartbeatAdjustment() {
        if (this.heartbeatAdjustTimer) {
            clearInterval(this.heartbeatAdjustTimer);
            this.heartbeatAdjustTimer = null;
        }
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
                        // log.debug(`[Lock] ${lockKey} is held by active instance ${existing.instanceId}`);
                        return false;
                    }
                    
                    // 锁持有者已下线，允许抢占
                    logWithProvider().info(`🔒 发现残留锁 ${lockKey} (持有者 ${existing.instanceId} 已下线)，允许抢占`);
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
            logWithProvider().debug(`[Lock verify] key=${lockKey}, existing=${existing?.instanceId}, verified=${verified?.instanceId}, self=${this.instanceId}`);

            if (verified && verified.instanceId === this.instanceId) {
                return true;
            }
            
            // 被其他实例抢先覆盖了
            return false;
        } catch (e) {
            logWithProvider().error(`获取锁失败 ${lockKey}:`, e?.message || String(e));
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
            logWithProvider().error(`释放锁失败 ${lockKey}:`, e?.message || String(e));
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
     * 原子化执行：检查锁并执行操作
     * 使用 Lua 脚本确保检查和执行的原子性，避免竞态条件
     * @param {string} lockKey - 锁的键
     * @param {Function} processor - 要执行的异步函数
     * @param {Object} options - 选项
     * @returns {Object} { status: 'success' | 'no_lock' | 'not_owner' | 'error', data: any }
     */
    async executeWithLock(lockKey, processor, options = {}) {
        const { lockTtl = 60, timeout = 5000 } = options;
        
        try {
            // 先尝试获取锁
            const acquired = await this._tryAcquire(lockKey, lockTtl);
            if (!acquired) {
                // 检查锁是否属于自己
                const lockData = await cache.get(`lock:${lockKey}`, "json", { skipCache: true });
                if (lockData && lockData.instanceId === this.instanceId) {
                    // 锁属于自己，执行操作
                    try {
                        const result = await processor();
                        return { status: 'success', data: result };
                    } catch (e) {
                        return { status: 'error', data: e.message };
                    }
                }
                return { status: 'no_lock', data: null };
            }
            
            // 锁获取成功，执行操作
            try {
                const result = await processor();
                return { status: 'success', data: result };
            } catch (e) {
                return { status: 'error', data: e.message };
            } finally {
                // 释放锁
                await this.releaseLock(lockKey);
            }
        } catch (e) {
            logWithProvider().error(`executeWithLock failed for ${lockKey}:`, e);
            return { status: 'error', data: e.message };
        }
    }

    /**
     * 广播系统事件到所有实例 (使用 QStash Topics)
     * @param {string} event - 事件名称
     * @param {object} data - 事件数据
     */
    async broadcast(event, data = {}) {
        try {
            await queueService.broadcastSystemEvent(event, {
                ...data,
                sourceInstance: this.instanceId,
                timestamp: Date.now()
            });
            logWithProvider().info(`📢 广播系统事件: ${event}`);
        } catch (error) {
            logWithProvider().error(`❌ 广播事件失败 ${event}:`, error);
        }
    }
}

// 导出单例实例
export const instanceCoordinator = new InstanceCoordinator();

// 导出获取实例 ID 的函数
export const getInstanceId = () => instanceCoordinator.instanceId;

// 默认导出
export default instanceCoordinator;
