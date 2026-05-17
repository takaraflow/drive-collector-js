import { d1 } from "../services/d1.js";
import { cache } from "../services/CacheService.js";
import { logger } from "../services/logger/index.js";
import { consistentCache as taskConsistentCache } from "../services/ConsistentCache.js";
import { stateSynchronizer as taskStateSynchronizer } from "../services/StateSynchronizer.js";
import { BatchProcessor } from "../services/BatchProcessor.js";
import {
    TASK_ACTIVE_STATUSES,
    TASK_EVENTS,
    TASK_STATUSES,
    TASK_TERMINAL_STATUSES,
    TaskStateMachine
} from "../domain/task-state-machine.js";
import { CACHE_KEYS } from "../domain/cache-keys.js";

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
    
    // 状态分类来自领域状态机；D1 是权威状态源，缓存只保留派生视图。
    static IMPORTANT_STATUSES = [TASK_STATUSES.DOWNLOADING, TASK_STATUSES.UPLOADING];
    static ACTIVE_STATUS_SQL = TASK_ACTIVE_STATUSES.map(() => '?').join(',');
    static ACTIVE_TASK_PREFIXES = [CACHE_KEYS.prefixes.taskStatus, CACHE_KEYS.prefixes.consistentTask];
    static INSTANCE_PREFIX = CACHE_KEYS.prefixes.instance;
    static INSTANCE_STALE_MS = 2 * 60 * 1000;

    static _getChanges(result) {
        if (!result) return 0;
        if (Number.isFinite(result.changes)) return result.changes;
        if (Number.isFinite(result.meta?.changes)) return result.meta.changes;
        return result.success === true ? 1 : 0;
    }

    static _placeholders(values) {
        return values.map(() => '?').join(',');
    }

    static async _getCurrentTaskState(taskId) {
        return await d1.fetchOne("SELECT id, status, updated_at FROM tasks WHERE id = ?", [taskId]);
    }

    static async _getCurrentStatus(taskId) {
        const row = await this._getCurrentTaskState(taskId);
        return row?.status || null;
    }

    static async _syncDerivedTaskState(taskId, status, errorMsg = null) {
        const payload = { status, errorMsg, updatedAt: Date.now() };
        const operations = [
            cache.delete(`task:${taskId}:details`)
        ];

        if (TASK_TERMINAL_STATUSES.includes(status)) {
            operations.push(
                cache.delete(CACHE_KEYS.taskStatus(taskId)),
                taskConsistentCache?.delete?.(`task:${taskId}`),
                taskStateSynchronizer?.clearTaskState?.(taskId)
            );
        } else {
            operations.push(
                cache.set(CACHE_KEYS.taskStatus(taskId), payload, 300),
                taskConsistentCache?.set?.(`task:${taskId}`, payload, { ttl: 300 }),
                taskStateSynchronizer?.updateTaskState?.(taskId, payload)
            );
        }

        const results = await Promise.allSettled(operations.filter(Boolean));
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length > 0) {
            log.warn(`TaskRepository derived state sync partially failed for ${taskId}`, {
                failures: failures.map(result => result.reason?.message || String(result.reason))
            });
        }
    }

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

        try {
            const results = await Promise.allSettled(
                updatesToFlush.map(update =>
                    this.transitionStatus(update.taskId, update.event || update.status, update.errorMsg, {
                        allowNoop: true,
                        source: update.source || 'memory_buffer_flush'
                    })
                )
            );

            results.forEach((result, index) => {
                const update = updatesToFlush[index];
                if (result.status === 'rejected') {
                    log.error(`Task flush failed for ${update.taskId}:`, result.reason);
                }

                const current = this.pendingUpdates.get(update.taskId);
                if (current === update) this.pendingUpdates.delete(update.taskId);
            });

            // 如果还有剩余任务，立即安排下一次刷新，而不是等待 10s
            if (this.pendingUpdates.size > 0) {
                setTimeout(() => this.flushUpdates(), 1000);
            }

        } catch (error) {
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
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                taskData.id,
                taskData.userId,
                taskData.chatId,
                taskData.msgId,
                taskData.sourceMsgId,
                taskData.fileName || 'unknown',
                taskData.fileSize || 0,
                TASK_STATUSES.QUEUED,
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
            return await d1.fetchAll(
                `SELECT * FROM tasks
                WHERE status IN (${this.ACTIVE_STATUS_SQL})
                AND (updated_at IS NULL OR updated_at < ?)
                ORDER BY created_at ASC
                LIMIT ?`,
                [...TASK_ACTIVE_STATUSES, deadLine, limit]
            );
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
            const result = await this.transitionStatus(taskId, TASK_EVENTS.START_DOWNLOAD, null, {
                claimedBy: instanceId,
                returnResult: true,
                allowNoop: true,
                source: 'claimTask'
            });

            return result.changed || result.idempotent;
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
            const results = await Promise.allSettled(
                taskIds.map(taskId => this.transitionStatus(taskId, TASK_EVENTS.RESET_STALLED, null, {
                    returnResult: true,
                    allowNoop: true,
                    source: 'resetStalledTasks'
                }))
            );

            return results.reduce((count, result, index) => {
                if (result.status !== 'fulfilled') {
                    log.warn(`TaskRepository.resetStalledTasks failed for ${taskIds[index]}`, {
                        error: result.reason?.message || String(result.reason)
                    });
                    return count;
                }
                return count + (result.value?.changed ? 1 : 0);
            }, 0);
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
            throw e;
        }
    }

    static _buildTransitionSql(targetStatus, options = {}) {
        const assignments = ["status = ?", "error_msg = ?", "updated_at = ?"];
        const params = [targetStatus, options.errorMsg ?? null, options.now];

        if (Object.prototype.hasOwnProperty.call(options, 'claimedBy') && options.claimedBy !== undefined) {
            assignments.push("claimed_by = ?");
            params.push(options.claimedBy);
        } else if (targetStatus === TASK_STATUSES.QUEUED || TASK_TERMINAL_STATUSES.includes(targetStatus)) {
            assignments.push("claimed_by = NULL");
        }

        return { assignments, params };
    }

    static _transitionResult(result, options = {}) {
        if (options.strict && result.blocked) {
            throw new Error(result.reason || "Task transition blocked");
        }
        return options.returnResult ? result : result.changed;
    }

    /**
     * Canonical task state transition.
     * D1 is the authoritative state source; Redis/consistent caches are derived views.
     */
    static async transitionStatus(taskId, eventOrStatus, errorMsg = null, options = {}) {
        if (!taskId) {
            throw new Error("TaskRepository.transitionStatus: Missing taskId.");
        }

        const event = TaskStateMachine.getTransition(eventOrStatus)
            ? eventOrStatus
            : TaskStateMachine.getEventForTargetStatus(eventOrStatus);
        const targetStatus = TaskStateMachine.targetStatusForEvent(event);
        const currentTaskState = await this._getCurrentTaskState(taskId);
        const currentStatus = currentTaskState?.status || null;

        if (!currentStatus) {
            return this._transitionResult({
                changed: false,
                blocked: true,
                reason: "Task not found",
                taskId,
                event,
                toStatus: targetStatus,
                queueAttempt: null
            }, options);
        }

        const resolution = TaskStateMachine.resolveTransition(currentStatus, event);
        if (!resolution.allowed) {
            log.warn("Blocked invalid task transition", { taskId, ...resolution });
            return this._transitionResult({
                changed: false,
                blocked: true,
                taskId,
                ...resolution
            }, options);
        }

        const now = Date.now();
        const { assignments, params } = this._buildTransitionSql(targetStatus, {
            now,
            errorMsg,
            claimedBy: options.claimedBy
        });

        const result = await d1.run(
            `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND status = ?`,
            [...params, taskId, currentStatus]
        );

        const changed = this._getChanges(result) > 0;
        if (!changed) {
            const latestState = await this._getCurrentTaskState(taskId);
            const latestStatus = latestState?.status || null;
            const racedToTarget = latestStatus === targetStatus;
            return this._transitionResult({
                changed: false,
                blocked: !racedToTarget,
                conflict: !racedToTarget,
                taskId,
                event,
                fromStatus: currentStatus,
                latestStatus,
                toStatus: targetStatus,
                idempotent: racedToTarget,
                queueAttempt: racedToTarget
                    ? `${targetStatus}:${latestState?.updated_at || now}`
                    : `${currentStatus}:${currentTaskState.updated_at || now}`,
                reason: racedToTarget ? null : `Task status changed concurrently from ${currentStatus} to ${latestStatus}`
            }, options);
        }

        this.pendingUpdates.delete(taskId);
        await this._syncDerivedTaskState(taskId, targetStatus, errorMsg);

        return this._transitionResult({
            changed: true,
            blocked: false,
            taskId,
            event,
            fromStatus: currentStatus,
            toStatus: targetStatus,
            idempotent: resolution.idempotent,
            queueAttempt: `${targetStatus}:${now}`
        }, options);
    }

    /**
     * Backward-compatible facade. New code should prefer transitionStatus(event).
     */
    static async updateStatus(taskId, status, errorMsg = null, options = {}) {
        return this.transitionStatus(taskId, status, errorMsg, options);
    }

    /**
     * 标记任务为已取消
     */
    static async markCancelled(taskId) {
        try {
            await this.transitionStatus(taskId, TASK_EVENTS.CANCEL, null, {
                allowNoop: true,
                source: 'markCancelled'
            });
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
     * 获取单个用户的队列概览。D1 tasks 表是队列状态的权威来源。
     * @param {string} userId - 用户 ID
     * @param {number} limit - 活跃/最近任务列表最大条数
     * @returns {Promise<{statusCounts: Object, activeTasks: Array, recentTasks: Array}>}
     */
    static async getUserQueueOverview(userId, limit = 10) {
        if (!userId) {
            return { statusCounts: {}, activeTasks: [], recentTasks: [] };
        }

        const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
        const [statusCounts, activeTasks, recentTasks] = await Promise.all([
            d1.fetchAll(
                "SELECT status, COUNT(*) as count FROM tasks WHERE user_id = ? GROUP BY status",
                [userId]
            ),
            d1.fetchAll(
                `SELECT id, file_name, file_size, status, created_at, updated_at FROM tasks WHERE user_id = ? AND status IN (${this.ACTIVE_STATUS_SQL}) ORDER BY updated_at DESC LIMIT ?`,
                [userId, ...TASK_ACTIVE_STATUSES, safeLimit]
            ),
            d1.fetchAll(
                "SELECT id, file_name, status, error_msg, created_at, updated_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
                [userId, safeLimit]
            )
        ]);

        const statusMap = {};
        for (const row of (statusCounts || [])) {
            statusMap[row.status] = row.count;
        }

        return {
            statusCounts: statusMap,
            activeTasks: activeTasks || [],
            recentTasks: recentTasks || []
        };
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
                "SELECT id, file_name, file_size, status FROM tasks WHERE user_id = ? AND status = ? ORDER BY created_at DESC",
                [userId, TASK_STATUSES.COMPLETED]
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
                "SELECT id, status FROM tasks WHERE user_id = ? AND file_name = ? AND file_size = ? AND status = ? ORDER BY created_at DESC LIMIT 1",
                [userId, fileName, fileSize, TASK_STATUSES.COMPLETED]
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
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            params: [
                taskData.id,
                taskData.userId,
                taskData.chatId,
                taskData.msgId,
                taskData.sourceMsgId,
                taskData.fileName || 'unknown',
                taskData.fileSize || 0,
                TASK_STATUSES.QUEUED,
                now,
                now
            ]
        }));

        try {
            const results = await d1.batch(statements);
            const failed = (results || []).find((result, index) => {
                if (!result) return true;
                if (result.success === false) return true;
                if (result.error) return true;
                return index >= statements.length;
            });

            if (!Array.isArray(results) || results.length !== statements.length || failed) {
                const failedIndex = Array.isArray(results) ? results.indexOf(failed) : -1;
                const detail = failed?.error?.message || failed?.result?.error || "unknown batch failure";
                throw new Error(`TaskRepository.createBatch failed at statement ${failedIndex >= 0 ? failedIndex : "unknown"}: ${detail}`);
            }

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
        return this.transitionStatus(taskId, status, errorMsg, { source: 'updateStatusWithConsistency' });
    }

    /**
     * 使用 StateSynchronizer 更新任务状态（状态同步）
     * 确保状态变更的原子性和一致性
     */
    static async updateStatusSynchronized(taskId, status, errorMsg = null) {
        return this.transitionStatus(taskId, status, errorMsg, { source: 'updateStatusSynchronized' });
    }

    /**
     * 使用 BatchProcessor 批量更新任务状态
     * @param {Array<Object>} updates - 更新数组 [{taskId, status, errorMsg}]
     */
    static async updateStatusBatch(updates) {
        if (!updates || updates.length === 0) return;
        await Promise.all(updates.map(u =>
            this.transitionStatus(u.taskId, u.event || u.status, u.errorMsg, {
                source: 'updateStatusBatch',
                allowNoop: true
            })
        ));
    }

    /**
     * 从 ConsistentCache 读取任务状态
     * 用于多实例间状态同步
     */
    static async getTaskStatusFromCache(taskId) {
        try {
            return await taskConsistentCache?.get?.(`task:${taskId}`);
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
            return await taskStateSynchronizer?.getTaskState?.(taskId);
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
                taskConsistentCache?.delete?.(`task:${taskId}`),
                taskStateSynchronizer?.clearTaskState?.(taskId),
                cache.delete(CACHE_KEYS.taskStatus(taskId)),
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
            await Promise.allSettled(taskIds.map(id => taskStateSynchronizer?.clearTaskState?.(id)));

            // 批量清理 Redis
            const redisKeys = taskIds.map(id => CACHE_KEYS.taskStatus(id));
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
                `SELECT id, user_id, file_name, file_size, status, created_at, updated_at FROM tasks WHERE status IN (${this.ACTIVE_STATUS_SQL}) ORDER BY updated_at DESC LIMIT ?`,
                [...TASK_ACTIVE_STATUSES, limit]
            ),
            d1.fetchAll(
                `SELECT user_id, COUNT(*) as count FROM tasks WHERE status IN (${this.ACTIVE_STATUS_SQL}) GROUP BY user_id ORDER BY count DESC LIMIT 5`,
                [...TASK_ACTIVE_STATUSES]
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

    /**
     * 按状态分页查询任务
     * @param {string} status - 任务状态
     * @param {number} page - 页码（从 0 开始）
     * @param {number} pageSize - 每页条数，默认 10
     * @returns {Promise<{tasks: Array, total: number, page: number, pageSize: number, totalPages: number}>}
     */
    static async getTasksByStatus(status, page = 0, pageSize = 10) {
        const offset = page * pageSize;
        const [tasks, countRow] = await Promise.all([
            d1.fetchAll(
                "SELECT id, user_id, file_name, file_size, status, error_msg, created_at, updated_at FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                [status, pageSize, offset]
            ),
            d1.fetchOne(
                "SELECT COUNT(*) as total FROM tasks WHERE status = ?",
                [status]
            )
        ]);
        return {
            tasks: tasks || [],
            total: countRow?.total || 0,
            page,
            pageSize,
            totalPages: Math.ceil((countRow?.total || 0) / pageSize)
        };
    }
}
