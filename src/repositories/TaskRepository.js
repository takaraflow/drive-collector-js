import { d1 } from "../services/d1.js";
import { cache } from "../services/CacheService.js";
import { logger } from "../services/logger/index.js";
import { ConsistentCache } from "../services/ConsistentCache.js";
import { StateSynchronizer } from "../services/StateSynchronizer.js";
import { BatchProcessor } from "../services/BatchProcessor.js";

const log = logger.withModule ? logger.withModule('TaskRepository') : logger;

/**
 * 任务数据仓储层
 * 负责与 'tasks' 表进行交互，隔离 SQL 细节
 */
export class TaskRepository {
    static pendingUpdates = new Map();
    static flushTimer = null;
    static cleanupTimer = null;
    static activeTaskCountCache = { value: 0, updatedAt: 0 };
    static activeTaskCountPromise = null;
    static STALLED_TASKS_DEFAULT_LIMIT = 200;
    static STALLED_TASKS_MIN_LIMIT = 50;
    static STALLED_TASKS_MAX_LIMIT = 1000;
    static MAX_PENDING_UPDATES = 1000; // Max size limit for pendingUpdates Map
    
    // 重要的中间状态（需要 Redis 中转，避免实例崩溃时丢失）
    static IMPORTANT_STATUSES = ['downloading', 'uploading'];
    static ACTIVE_TASK_PREFIXES = ['task_status:', 'consistent:task:'];
    static INSTANCE_PREFIX = 'instance:';
    static INSTANCE_STALE_MS = 2 * 60 * 1000;

    /**
     * 启动定时刷新任务
     */
    static startFlushing() {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => this.flushUpdates(), 10000); // 每 10 秒刷新一次

        // 启动定期清理任务，每5分钟清理一次过期条目
        if (!this.cleanupTimer) {
            this.cleanupTimer = setInterval(() => this.cleanupExpiredUpdates(), 5 * 60 * 1000);
        }
    }

    /**
     * 清理过期的待更新条目（防止内存泄漏）
     * 移除超过30分钟未处理的条目
     */
    static cleanupExpiredUpdates() {
        const now = Date.now();
        const expiryTime = 30 * 60 * 1000; // 30分钟
        let cleanedCount = 0;

        for (const [taskId, update] of this.pendingUpdates) {
            // 检查更新对象的创建时间（通过 update 对象本身的时间戳）
            if (update.timestamp && (now - update.timestamp) > expiryTime) {
                this.pendingUpdates.delete(taskId);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            log.info(`🧹 TaskRepository 清理了 ${cleanedCount} 个过期的待更新条目`);
        }
    }

    /**
     * 将积压的更新批量写入数据库
     * 每次最多处理 50 条，防止并发请求过多阻塞网络导致 Telegram 连接断开
     */
    static async flushUpdates() {
        if (this.pendingUpdates.size === 0) return;
        
        // Size-based eviction: remove oldest entries if over limit
        if (this.pendingUpdates.size > this.MAX_PENDING_UPDATES) {
            const sortedEntries = [...this.pendingUpdates.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
            const entriesToRemove = sortedEntries.slice(0, this.pendingUpdates.size - this.MAX_PENDING_UPDATES);
            for (const [taskId] of entriesToRemove) {
                this.pendingUpdates.delete(taskId);
            }
        }

        // 获取待处理的任务列表
        const allUpdates = Array.from(this.pendingUpdates.values());
        // 限制每次只处理前 50 条 (流量控制)
        const updatesToFlush = allUpdates.slice(0, 50);

        const now = Date.now();
        const statements = updatesToFlush.map(u => ({
            sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
            params: [u.status, u.errorMsg, now, u.taskId]
        }));

        try {
            // 使用新版 batch，返回结果数组
            const results = await d1.batch(statements);

            // 遍历结果，只清除已处理的任务
            results.forEach((res, index) => {
                const update = updatesToFlush[index];

                if (!res.success) {
                    log.error(`Task flush failed for ${update.taskId}:`, res.error);
                }

                // 无论成功还是失败，都从队列中移除，防止毒丸(poison pill)效应导致无限循环
                // 注意：需检查引用是否一致，防止清除期间产生的新更新被误删
                const current = this.pendingUpdates.get(update.taskId);
                if (current === update) {
                    this.pendingUpdates.delete(update.taskId);
                }
            });

            // 如果还有剩余任务，立即安排下一次刷新，而不是等待 10s
            if (this.pendingUpdates.size > 0) {
                setTimeout(() => this.flushUpdates(), 1000);
            }

        } catch (error) {
            // 如果 batch 本身抛出异常（极少见，因为我们用了 Promise.allSettled）
            log.error("TaskRepository.flushUpdates critical error:", error);
        }
    }

    /**
     * 获取活跃任务数量（缓存层估算，同步返回缓存值，后台刷新）
     * 如需最新值，请调用 refreshActiveTaskCount 并 await
     */
    static getActiveTaskCount(options = {}) {
        const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 10000;
        const now = Date.now();
        const lastUpdated = this.activeTaskCountCache.updatedAt;

        if (now - lastUpdated > maxAgeMs && !this.activeTaskCountPromise) {
            void this.refreshActiveTaskCount();
        }

        return this.activeTaskCountCache.value;
    }

    /**
     * 刷新活跃任务数量缓存（D1 查询）
     * @returns {Promise<number>} 当前活跃任务数量
     */
    static async refreshActiveTaskCount() {
        if (this.activeTaskCountPromise) {
            return this.activeTaskCountPromise;
        }

        const refreshPromise = (async () => {
            try {
                // 1) Prefer instance-level activeTaskCount aggregation (best-effort, cache-native)
                const instanceKeys = await cache.listKeys(this.INSTANCE_PREFIX);
                if (Array.isArray(instanceKeys) && instanceKeys.length > 0) {
                    const now = Date.now();
                    const instanceDatas = await Promise.allSettled(
                        instanceKeys.map(key => cache.get(key, 'json', { cacheTtl: 30000 }))
                    );

                    let sum = 0;
                    let hasAny = false;

                    instanceDatas.forEach((result) => {
                        if (result.status !== 'fulfilled') return;
                        const data = result.value;
                        if (!data) return;

                        const lastHeartbeat = Number.parseInt(data.lastHeartbeat, 10);
                        if (Number.isFinite(lastHeartbeat) && now - lastHeartbeat > this.INSTANCE_STALE_MS) {
                            return;
                        }

                        const count = Number.parseInt(data.activeTaskCount, 10);
                        if (!Number.isFinite(count) || Number.isNaN(count)) return;
                        hasAny = true;
                        sum += Math.max(0, count);
                    });

                    // Include local in-memory buffer as a tiny safety net (in case instance counter not wired)
                    if (this.pendingUpdates.size > 0) {
                        hasAny = true;
                        sum += this.pendingUpdates.size;
                    }

                    if (hasAny) {
                        this.activeTaskCountCache = { value: sum, updatedAt: Date.now() };
                        return sum;
                    }
                }

                // 2) Fallback: derive from task status keys
                const results = await Promise.allSettled(
                    this.ACTIVE_TASK_PREFIXES.map(prefix => cache.listKeys(prefix))
                );

                const taskIds = new Set();
                let hasFulfilled = false;

                results.forEach((result, index) => {
                    if (result.status !== 'fulfilled') return;
                    hasFulfilled = true;
                    const prefix = this.ACTIVE_TASK_PREFIXES[index];
                    result.value.forEach((key) => {
                        if (key.startsWith(prefix)) {
                            taskIds.add(key.slice(prefix.length));
                        }
                    });
                });

                for (const taskId of this.pendingUpdates.keys()) {
                    taskIds.add(String(taskId));
                }

                if (!hasFulfilled && this.pendingUpdates.size === 0) {
                    return this.activeTaskCountCache.value;
                }

                this.activeTaskCountCache = { value: taskIds.size, updatedAt: Date.now() };
                return taskIds.size;
            } catch (error) {
                log.warn('TaskRepository.refreshActiveTaskCount failed:', error.message);
            }

            return this.activeTaskCountCache.value;
        })();

        this.activeTaskCountPromise = refreshPromise;
        refreshPromise.finally(() => {
            this.activeTaskCountPromise = null;
        });

        return refreshPromise;
    }

    /**
     * 创建新任务
     * @param {Object} taskData - 任务数据对象
     */
    static async create(taskData) {
        if (!taskData.id || !taskData.userId) {
            throw new Error("TaskRepository.create: Missing required fields (id or userId).");
        }

        try {
            await d1.run(`
                INSERT INTO tasks (id, user_id, chat_id, msg_id, source_msg_id, file_name, file_size, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
            `, [
                taskData.id,
                taskData.userId,
                taskData.chatId,
                taskData.msgId,
                taskData.sourceMsgId,
                taskData.fileName || 'unknown',
                taskData.fileSize || 0,
                Date.now(),
                Date.now()
            ]);
            return true;
        } catch (e) {
            log.error(`TaskRepository.create failed for ${taskData.id}:`, e);
            throw e;
        }
    }

    /**
     * 查找所有“僵尸”任务（长时间未更新的任务）
     */
    static async findStalledTasks(timeoutMs, options = {}) {
        const safeTimeout = Math.max(0, timeoutMs || 0);
        const deadLine = Date.now() - safeTimeout;
        const requestedLimit = Number.isFinite(options?.maxResults) ? Number(options.maxResults) : this.STALLED_TASKS_DEFAULT_LIMIT;
        const limit = Math.min(this.STALLED_TASKS_MAX_LIMIT, Math.max(this.STALLED_TASKS_MIN_LIMIT, requestedLimit));

        try {
            // 1. 从 D1 获取僵尸任务
            const d1Tasks = await d1.fetchAll(
                `SELECT * FROM tasks
                WHERE status IN ('queued', 'downloading', 'downloaded', 'uploading')
                AND (updated_at IS NULL OR updated_at < ?)
                ORDER BY created_at ASC
                LIMIT ?`,
                [deadLine, limit]
            );
            
            // 2. 从 Redis 获取重要的中间状态任务
            const redisTasks = [];
            try {
                const keys = await cache.listKeys('task_status:*');
                for (const key of keys) {
                    const data = await cache.get(key, 'json');
                    if (data && data.updatedAt && data.updatedAt < deadLine) {
                        redisTasks.push({
                            id: key.replace('task_status:', ''),
                            status: data.status,
                            updated_at: data.updatedAt,
                            source: 'redis'
                        });
                    }
                }
            } catch (e) {
                log.warn('TaskRepository.findStalledTasks Redis check failed:', e.message);
            }
            
            // 合并结果（去重）
            const d1TaskIds = new Set(d1Tasks.map(t => t.id));
            const uniqueRedisTasks = redisTasks.filter(t => !d1TaskIds.has(t.id));
            
            return [...d1Tasks, ...uniqueRedisTasks];
        } catch (e) {
            log.error("TaskRepository.findStalledTasks error:", e);
            return [];
        }
    }

    /**
     * 原子化认领任务：将任务状态从 'queued' 改为 'downloading' 并记录认领实例
     * @param {string} taskId - 任务ID
     * @param {string} instanceId - 实例ID
     * @returns {boolean} 是否认领成功
     */
    static async claimTask(taskId, instanceId) {
        if (!taskId || !instanceId) {
            throw new Error("TaskRepository.claimTask: Missing required fields (taskId or instanceId).");
        }

        try {
            const result = await d1.run(
                "UPDATE tasks SET status = 'downloading', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
                [instanceId, Date.now(), taskId]
            );
            return result.changes > 0; // 如果更新了行，则认领成功
        } catch (e) {
            log.error(`TaskRepository.claimTask failed for ${taskId}:`, e);
            return false;
        }
    }

    /**
     * 重置僵尸任务：将长时间未更新的任务重置为 'queued' 状态，清除认领信息
     * @param {Array<string>} taskIds - 要重置的任务ID数组
     * @returns {number} 重置的任务数量
     */
    static async resetStalledTasks(taskIds) {
        if (!taskIds || taskIds.length === 0) return 0;

        try {
            const placeholders = taskIds.map(() => '?').join(',');
            const result = await d1.run(
                `UPDATE tasks SET status = 'queued', claimed_by = NULL, updated_at = ? WHERE id IN (${placeholders}) AND status IN ('downloading', 'uploading')`,
                [Date.now(), ...taskIds]
            );
            return result.changes;
        } catch (e) {
            log.error("TaskRepository.resetStalledTasks failed:", e);
            return 0;
        }
    }

    /**
     * 根据 ID 获取任务
     */
    static async findById(taskId) {
        if (!taskId) return null;
        
        // 尝试从缓存获取
        const cacheKey = `task:${taskId}:details`;
        try {
            const cachedTask = await cache.get(cacheKey, 'json');
            if (cachedTask) {
                return cachedTask;
            }
        } catch (e) {
            // 缓存读取失败，继续查询数据库
        }
        
        try {
            const task = await d1.fetchOne("SELECT * FROM tasks WHERE id = ?", [taskId]);
            if (task) {
                // 缓存任务详情，过期时间 5 分钟
                try {
                    await cache.set(cacheKey, task, 300);
                } catch (e) {
                    // 缓存写入失败，忽略
                }
            }
            return task;
        } catch (e) {
            log.error(`TaskRepository.findById error for ${taskId}:`, e);
            return null;
        }
    }

    /**
     * 更新任务状态（内存缓冲版 + Redis 中转）
     * Critical: completed/failed/cancelled → 立即写入 D1
     * Important: downloading/uploading → Redis 中转（实时可见）
     * Minor: 其他 → 内存缓冲
     */
    static async updateStatus(taskId, status, errorMsg = null) {
        const isCritical = ['completed', 'failed', 'cancelled'].includes(status);
        const isImportant = this.IMPORTANT_STATUSES.includes(status);
        
        // 清除任务详情缓存
        try {
            await cache.delete(`task:${taskId}:details`);
        } catch (e) {
            // 忽略缓存删除错误
        }
        
        // Critical: 立即写入 D1，从缓冲和 Redis 中清除
        if (isCritical) {
            this.pendingUpdates.delete(taskId);
            try {
                await d1.run(
                    "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    [status, errorMsg, Date.now(), taskId]
                );
            } catch (e) {
                log.error(`TaskRepository.updateStatus (critical) failed for ${taskId}:`, e);
            }
            // 也从 Redis 中清除
            try {
                await cache.delete(`task_status:${taskId}`);
            } catch (e) {
                // Ignore Redis errors
            }
            return;
        }
        
        // Important: 使用 Redis 中转（实时可见 + 持久化）
        if (isImportant) {
            try {
                await cache.set(
                    `task_status:${taskId}`,
                    { status, errorMsg, updatedAt: Date.now() },
                    300  // 5分钟过期
                );
            } catch (e) {
                log.warn(`TaskRepository Redis update failed for ${taskId}:`, e.message);
                // Fallback to memory buffer
                this.pendingUpdates.set(taskId, {
                    taskId,
                    status,
                    errorMsg,
                    timestamp: Date.now(),
                    updatedAt: Date.now(),
                    source: 'redis_fallback'
                });
                this.startFlushing();
            }
            return;
        }
        
        // Minor: 继续缓冲
        this.pendingUpdates.set(taskId, {
            taskId,
            status,
            errorMsg,
            timestamp: Date.now(),
            updatedAt: Date.now(),
            source: 'memory_buffer'
        });
        this.startFlushing();
    }

    /**
     * 标记任务为已取消
     */
    static async markCancelled(taskId) {
        try {
            await d1.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [taskId]);
        } catch (e) {
            log.error(`TaskRepository.markCancelled failed for ${taskId}:`, e);
        }
    }

    /**
     * 根据用户ID获取该用户最近的任务（用于状态显示）
     */
    static async findByUserId(userId, limit = 10) {
        if (!userId) return [];
        
        // 尝试从缓存获取
        const cacheKey = `tasks:user:${userId}:recent:${limit}`;
        try {
            const cachedTasks = await cache.get(cacheKey, 'json');
            if (cachedTasks) {
                return cachedTasks;
            }
        } catch (e) {
            // 缓存读取失败，继续查询数据库
        }
        
        try {
            const tasks = await d1.fetchAll(
                "SELECT id, file_name, status, error_msg, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
                [userId, limit]
            );
            
            // 缓存用户最近任务，过期时间 1 分钟
            try {
                await cache.set(cacheKey, tasks, 60);
            } catch (e) {
                // 缓存写入失败，忽略
            }
            
            return tasks;
        } catch (e) {
            log.error(`TaskRepository.findByUserId error for ${userId}:`, e);
            return [];
        }
    }

    /**
     * 根据 msg_id 获取该消息组下的所有任务状态（用于看板）
     */
    static async findByMsgId(msgId) {
        if (!msgId) return [];
        
        // 尝试从缓存获取
        const cacheKey = `tasks:msg:${msgId}:group`;
        try {
            const cachedTasks = await cache.get(cacheKey, 'json');
            if (cachedTasks) {
                return cachedTasks;
            }
        } catch (e) {
            // 缓存读取失败，继续查询数据库
        }
        
        try {
            const tasks = await d1.fetchAll(
                "SELECT id, user_id, chat_id, msg_id, file_name, status, error_msg FROM tasks WHERE msg_id = ? ORDER BY created_at ASC",
                [msgId]
            );
            
            // 缓存消息组任务，过期时间 2 分钟
            try {
                await cache.set(cacheKey, tasks, 120);
            } catch (e) {
                // 缓存写入失败，忽略
            }
            
            return tasks;
        } catch (e) {
            log.error(`TaskRepository.findByMsgId error for ${msgId}:`, e);
            return [];
        }
    }

    /**
     * 根据用户ID查找所有已完成的相同文件任务（用于重复检查）
     */
    static async findAllCompletedByUser(userId) {
        if (!userId) return [];
        try {
            return await d1.fetchAll(
                "SELECT id, file_name, file_size, status FROM tasks WHERE user_id = ? AND status = 'completed' ORDER BY created_at DESC",
                [userId]
            );
        } catch (e) {
            log.error(`TaskRepository.findAllCompletedByUser error for ${userId}:`, e);
            return [];
        }
    }

    /**
     * 根据用户ID、文件名和文件大小查找已完成的相同文件任务（用于重复检查）
     */
    static async findCompletedByFile(userId, fileName, fileSize) {
        if (!userId || !fileName || fileSize == null) return null;
        
        // 尝试从缓存获取
        const cacheKey = `tasks:user:${userId}:file:${fileName}:${fileSize}:completed`;
        try {
            const cachedTask = await cache.get(cacheKey, 'json');
            if (cachedTask) {
                return cachedTask;
            }
        } catch (e) {
            // 缓存读取失败，继续查询数据库
        }
        
        try {
            const task = await d1.fetchOne(
                "SELECT id, status FROM tasks WHERE user_id = ? AND file_name = ? AND file_size = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
                [userId, fileName, fileSize]
            );
            
            // 缓存已完成文件任务，过期时间 10 分钟
            try {
                await cache.set(cacheKey, task, 600);
            } catch (e) {
                // 缓存写入失败，忽略
            }
            
            return task;
        } catch (e) {
            log.error(`TaskRepository.findCompletedByFile error for ${userId}/${fileName}:`, e);
            return null;
        }
    }

    /**
     * 批量创建任务
     */
    static async createBatch(tasksData) {
        if (!tasksData || tasksData.length === 0) return true;

        const now = Date.now();
        const statements = tasksData.map(taskData => ({
            sql: `
                INSERT INTO tasks (id, user_id, chat_id, msg_id, source_msg_id, file_name, file_size, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
            `,
            params: [
                taskData.id,
                taskData.userId,
                taskData.chatId,
                taskData.msgId,
                taskData.sourceMsgId,
                taskData.fileName || 'unknown',
                taskData.fileSize || 0,
                now,
                now
            ]
        }));

        try {
            await d1.batch(statements);
            return true;
        } catch (e) {
            log.error("TaskRepository.createBatch failed:", e);
            throw e;
        }
    }

    /**
     * 使用 ConsistentCache 更新任务状态（一致性缓存）
     * 确保多实例间状态同步，避免重复处理
     */
    static async updateStatusWithConsistency(taskId, status, errorMsg = null) {
        const isCritical = ['completed', 'failed', 'cancelled'].includes(status);
        const isImportant = this.IMPORTANT_STATUSES.includes(status);
        
        // Critical: 立即写入 D1 + 清除缓存
        if (isCritical) {
            this.pendingUpdates.delete(taskId);
            try {
                await d1.run(
                    "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    [status, errorMsg, Date.now(), taskId]
                );
            } catch (e) {
                log.error(`TaskRepository.updateStatusWithConsistency (critical) failed for ${taskId}:`, e);
            }
            // 清除 ConsistentCache
            try {
                await ConsistentCache.delete(`task:${taskId}`);
            } catch (e) {
                // Ignore
            }
            return;
        }
        
        // Important: 使用 ConsistentCache（带 TTL）
        if (isImportant) {
            try {
                await ConsistentCache.set(
                    `task:${taskId}`,
                    { status, errorMsg, updatedAt: Date.now() },
                    300  // 5分钟过期
                );
            } catch (e) {
                log.warn(`TaskRepository ConsistentCache update failed for ${taskId}:`, e.message);
                // Fallback to memory buffer
                this.pendingUpdates.set(taskId, {
                    taskId,
                    status,
                    errorMsg,
                    timestamp: Date.now(),
                    updatedAt: Date.now(),
                    source: 'consistent_fallback'
                });
                this.startFlushing();
            }
            return;
        }
        
        // Minor: 继续缓冲
        this.pendingUpdates.set(taskId, {
            taskId,
            status,
            errorMsg,
            timestamp: Date.now(),
            updatedAt: Date.now(),
            source: 'memory_buffer'
        });
        this.startFlushing();
    }

    /**
     * 使用 StateSynchronizer 更新任务状态（状态同步）
     * 确保状态变更的原子性和一致性
     */
    static async updateStatusSynchronized(taskId, status, errorMsg = null) {
        const isCritical = ['completed', 'failed', 'cancelled'].includes(status);
        const isImportant = this.IMPORTANT_STATUSES.includes(status);
        
        // Critical: 立即写入 D1
        if (isCritical) {
            this.pendingUpdates.delete(taskId);
            try {
                await d1.run(
                    "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    [status, errorMsg, Date.now(), taskId]
                );
            } catch (e) {
                log.error(`TaskRepository.updateStatusSynchronized (critical) failed for ${taskId}:`, e);
            }
            // 清除同步状态
            try {
                await StateSynchronizer.clearTaskState(taskId);
            } catch (e) {
                // Ignore
            }
            return;
        }
        
        // Important: 使用 StateSynchronizer
        if (isImportant) {
            try {
                await StateSynchronizer.updateTaskState(taskId, {
                    status,
                    errorMsg,
                    updatedAt: Date.now()
                });
            } catch (e) {
                log.warn(`TaskRepository StateSynchronizer update failed for ${taskId}:`, e.message);
                // Fallback to memory buffer
                this.pendingUpdates.set(taskId, {
                    taskId,
                    status,
                    errorMsg,
                    timestamp: Date.now(),
                    updatedAt: Date.now(),
                    source: 'synchronizer_fallback'
                });
                this.startFlushing();
            }
            return;
        }
        
        // Minor: 继续缓冲
        this.pendingUpdates.set(taskId, {
            taskId,
            status,
            errorMsg,
            timestamp: Date.now(),
            updatedAt: Date.now(),
            source: 'memory_buffer'
        });
        this.startFlushing();
    }

    /**
     * 使用 BatchProcessor 批量更新任务状态
     * @param {Array<Object>} updates - 更新数组 [{taskId, status, errorMsg}]
     */
    static async updateStatusBatch(updates) {
        if (!updates || updates.length === 0) return;

        // 分类处理
        const criticalUpdates = updates.filter(u => ['completed', 'failed', 'cancelled'].includes(u.status));
        const importantUpdates = updates.filter(u => this.IMPORTANT_STATUSES.includes(u.status));
        const minorUpdates = updates.filter(u => !criticalUpdates.includes(u) && !importantUpdates.includes(u));

        // Critical: 立即写入 D1
        if (criticalUpdates.length > 0) {
            const statements = criticalUpdates.map(u => ({
                sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                params: [u.status, u.errorMsg, Date.now(), u.taskId]
            }));

            try {
                await d1.batch(statements);
                // 清除缓存
                for (const u of criticalUpdates) {
                    this.pendingUpdates.delete(u.taskId);
                    try {
                        await ConsistentCache.delete(`task:${u.taskId}`);
                        await StateSynchronizer.clearTaskState(u.taskId);
                    } catch (e) {
                        // Ignore
                    }
                }
            } catch (e) {
                log.error("TaskRepository.updateStatusBatch critical updates failed:", e);
            }
        }

        // Important: 使用 BatchProcessor + ConsistentCache
        if (importantUpdates.length > 0) {
            try {
                // 使用 BatchProcessor 进行批量操作
                const batchOps = importantUpdates.map(u => ({
                    type: 'set',
                    key: `task:${u.taskId}`,
                    value: { status: u.status, errorMsg: u.errorMsg, updatedAt: Date.now() },
                    ttl: 300
                }));
                await BatchProcessor.processBatch('consistent-cache', batchOps);
            } catch (e) {
                log.warn(`TaskRepository updateStatusBatch important updates failed:`, e.message);
                // Fallback to memory buffer
                for (const u of importantUpdates) {
                    this.pendingUpdates.set(u.taskId, {
                        taskId: u.taskId,
                        status: u.status,
                        errorMsg: u.errorMsg,
                        timestamp: Date.now(),
                        updatedAt: Date.now(),
                        source: 'batch_fallback'
                    });
                }
                this.startFlushing();
            }
        }

        // Minor: 使用 BatchProcessor 内存缓冲
        if (minorUpdates.length > 0) {
            for (const u of minorUpdates) {
                this.pendingUpdates.set(u.taskId, {
                    taskId: u.taskId,
                    status: u.status,
                    errorMsg: u.errorMsg,
                    timestamp: Date.now(),
                    updatedAt: Date.now(),
                    source: 'batch_memory'
                });
            }
            this.startFlushing();
        }
    }

    /**
     * 从 ConsistentCache 读取任务状态
     * 用于多实例间状态同步
     */
    static async getTaskStatusFromCache(taskId) {
        try {
            return await ConsistentCache.get(`task:${taskId}`);
        } catch (e) {
            log.warn(`TaskRepository getTaskStatusFromCache failed for ${taskId}:`, e.message);
            return null;
        }
    }

    /**
     * 从 StateSynchronizer 读取任务状态
     * 用于状态同步和故障恢复
     */
    static async getTaskStatusSynchronized(taskId) {
        try {
            return await StateSynchronizer.getTaskState(taskId);
        } catch (e) {
            log.warn(`TaskRepository getTaskStatusSynchronized failed for ${taskId}:`, e.message);
            return null;
        }
    }

    /**
     * 获取任务的完整状态（多层查询）
     * 优先级：D1 > StateSynchronizer > ConsistentCache > Memory Buffer
     */
    static async getTaskStatusFull(taskId) {
        // 1. 查询 D1
        const d1Task = await this.findById(taskId);
        if (d1Task) return { source: 'd1', data: d1Task };

        // 2. 查询 StateSynchronizer
        const syncState = await this.getTaskStatusSynchronized(taskId);
        if (syncState) return { source: 'synchronizer', data: syncState };

        // 3. 查询 ConsistentCache
        const cacheState = await this.getTaskStatusFromCache(taskId);
        if (cacheState) return { source: 'consistent_cache', data: cacheState };

        // 4. 查询 Memory Buffer
        const memoryState = this.pendingUpdates.get(taskId);
        if (memoryState) return { source: 'memory', data: memoryState };

        return null;
    }

    /**
     * 批量获取任务状态
     */
    static async getTaskStatusBatch(taskIds) {
        if (!taskIds || taskIds.length === 0) return {};

        const results = {};

        // 1. 批量查询 D1
        try {
            const placeholders = taskIds.map(() => '?').join(',');
            const d1Tasks = await d1.fetchAll(
                `SELECT id, status, error_msg, updated_at FROM tasks WHERE id IN (${placeholders})`,
                taskIds
            );
            d1Tasks.forEach(task => {
                results[task.id] = { source: 'd1', data: task };
            });
        } catch (e) {
            log.error("TaskRepository.getTaskStatusBatch D1 query failed:", e);
        }

        // 2. 批量查询 ConsistentCache（未在 D1 中找到的）
        const remainingIds = taskIds.filter(id => !results[id]);
        if (remainingIds.length > 0) {
            try {
                const cacheKeys = remainingIds.map(id => `task:${id}`);
                const cacheResults = await BatchProcessor.processBatch('consistent-cache-read', cacheKeys);
                cacheResults.forEach((cacheData, index) => {
                    if (cacheData) {
                        results[remainingIds[index]] = { source: 'consistent_cache', data: cacheData };
                    }
                });
            } catch (e) {
                log.warn("TaskRepository.getTaskStatusBatch cache query failed:", e.message);
            }
        }

        // 3. 查询 Memory Buffer（前两层都未找到的）
        const stillRemaining = taskIds.filter(id => !results[id]);
        for (const id of stillRemaining) {
            const memoryState = this.pendingUpdates.get(id);
            if (memoryState) {
                results[id] = { source: 'memory', data: memoryState };
            }
        }

        return results;
    }

    /**
     * 获取任务的完整信息（包含缓存状态）
     * 用于任务详情展示和故障排查
     */
    static async getTaskInfo(taskId) {
        const baseInfo = await this.findById(taskId);
        if (!baseInfo) return null;

        // 获取缓存状态
        const cacheStatus = await this.getTaskStatusFull(taskId);

        return {
            ...baseInfo,
            cacheStatus: cacheStatus ? cacheStatus.source : 'none',
            cacheData: cacheStatus ? cacheStatus.data : null
        };
    }

    /**
     * 清理任务缓存（用于任务完成或取消后）
     */
    static async cleanupTaskCache(taskId) {
        try {
            await Promise.allSettled([
                ConsistentCache.delete(`task:${taskId}`),
                StateSynchronizer.clearTaskState(taskId),
                cache.delete(`task_status:${taskId}`),
                cache.delete(`task:${taskId}:details`)
            ]);
            this.pendingUpdates.delete(taskId);
        } catch (e) {
            log.warn(`TaskRepository cleanupTaskCache failed for ${taskId}:`, e.message);
        }
    }

    /**
     * 批量清理任务缓存
     */
    static async cleanupTaskCacheBatch(taskIds) {
        if (!taskIds || taskIds.length === 0) return;

        try {
            // 批量清理 ConsistentCache
            const cacheOps = taskIds.map(id => ({ type: 'delete', key: `task:${id}` }));
            await BatchProcessor.processBatch('consistent-cache', cacheOps);

            // 批量清理 StateSynchronizer
            await Promise.allSettled(taskIds.map(id => StateSynchronizer.clearTaskState(id)));

            // 批量清理 Redis
            const redisKeys = taskIds.map(id => `task_status:${id}`);
            await BatchProcessor.processBatch('redis-delete', redisKeys);

            // 清理内存
            taskIds.forEach(id => this.pendingUpdates.delete(id));
        } catch (e) {
            log.warn(`TaskRepository cleanupTaskCacheBatch failed:`, e.message);
        }
    }

    /**
     * 获取全局队列概览（管理员用）
     * @param {number} limit - 活跃任务列表最大条数，默认 10
     * @returns {Promise<{statusCounts: Object, activeTasks: Array, userCounts: Array}>}
     */
    static async getQueueOverview(limit = 10) {
        const [statusCounts, activeTasks, userCounts] = await Promise.all([
            d1.fetchAll("SELECT status, COUNT(*) as count FROM tasks GROUP BY status"),
            d1.fetchAll(
                "SELECT id, user_id, file_name, file_size, status, created_at, updated_at FROM tasks WHERE status IN ('queued','downloading','uploading') ORDER BY updated_at DESC LIMIT ?",
                [limit]
            ),
            d1.fetchAll(
                "SELECT user_id, COUNT(*) as count FROM tasks WHERE status IN ('queued','downloading','uploading') GROUP BY user_id ORDER BY count DESC LIMIT 5"
            )
        ]);

        const statusMap = {};
        for (const row of (statusCounts || [])) {
            statusMap[row.status] = row.count;
        }

        return {
            statusCounts: statusMap,
            activeTasks: activeTasks || [],
            userCounts: userCounts || []
        };
    }
}
