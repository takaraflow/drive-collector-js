import { d1 } from "./d1.js";

/**
 * --- D1 数据库服务 (任务队列层) ---
 * 负责任务的持久化、队列管理和状态更新
 * 替代原有的 TaskRepository
 */
export class DatabaseService {
    static pendingUpdates = new Map();
    static flushTimer = null;
    static cleanupTimer = null;

    /**
     * 启动定时刷新任务 (将高频状态更新缓冲后写入 D1)
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
     * 清理过期的待更新条目
     */
    static cleanupExpiredUpdates() {
        const now = Date.now();
        const expiryTime = 30 * 60 * 1000; // 30分钟
        let cleanedCount = 0;

        for (const [taskId, update] of this.pendingUpdates) {
            if (update.timestamp && (now - update.timestamp) > expiryTime) {
                this.pendingUpdates.delete(taskId);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            console.log(`🧹 DatabaseService 清理了 ${cleanedCount} 个过期的待更新条目`);
        }
    }

    /**
     * 将积压的更新批量写入数据库
     */
    static async flushUpdates() {
        if (this.pendingUpdates.size === 0) return;

        const allUpdates = Array.from(this.pendingUpdates.values());
        const updatesToFlush = allUpdates.slice(0, 50);
        const now = Date.now();

        const statements = updatesToFlush.map(u => ({
            sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
            params: [u.status, u.errorMsg, now, u.taskId]
        }));

        try {
            const results = await d1.batch(statements);
            results.forEach((res, index) => {
                const update = updatesToFlush[index];
                if (!res.success) {
                    console.error(`Task flush failed for ${update.taskId}:`, res.error);
                }
                const current = this.pendingUpdates.get(update.taskId);
                if (current === update) {
                    this.pendingUpdates.delete(update.taskId);
                }
            });

            if (this.pendingUpdates.size > 0) {
                setTimeout(() => this.flushUpdates(), 1000);
            }
        } catch (error) {
            console.error("DatabaseService.flushUpdates critical error:", error);
        }
    }

    /**
     * 创建新任务 (入队)
     */
    static async createTask(taskData) {
        if (!taskData.id || !taskData.userId) {
            throw new Error("createTask: Missing required fields (id or userId).");
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
            console.error(`createTask failed for ${taskData.id}:`, e);
            throw e;
        }
    }

    /**
     * 批量创建任务
     */
    static async createBatchTasks(tasksData) {
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
            console.error("createBatchTasks failed:", e);
            throw e;
        }
    }

    /**
     * 查找待处理或僵尸任务 (Worker 轮询用)
     * @param {number} timeoutMs - 超时时间，用于判断僵尸任务
     * @param {string} statusFilter - 'queued' | 'downloaded' | null (all)
     */
    static async findPendingTasks(timeoutMs = 300000, statusFilter = null) {
        const deadLine = Date.now() - timeoutMs;
        let sql = `SELECT * FROM tasks WHERE (updated_at IS NULL OR updated_at < ?)`;
        let params = [deadLine];

        if (statusFilter) {
            sql += ` AND status = ?`;
            params.push(statusFilter);
        } else {
            sql += ` AND status IN ('queued', 'downloading', 'downloaded', 'uploading')`;
        }

        sql += ` ORDER BY created_at ASC LIMIT 20`; // 限制每次拉取数量

        try {
            return await d1.fetchAll(sql, params);
        } catch (e) {
            console.error("findPendingTasks error:", e);
            return [];
        }
    }

    /**
     * 根据 ID 获取任务
     */
    static async getTaskById(taskId) {
        if (!taskId) return null;
        try {
            return await d1.fetchOne("SELECT * FROM tasks WHERE id = ?", [taskId]);
        } catch (e) {
            console.error(`getTaskById error for ${taskId}:`, e);
            return null;
        }
    }

    /**
     * 更新任务状态
     */
    static async updateTaskStatus(taskId, status, errorMsg = null) {
        const isCritical = ['completed', 'failed', 'cancelled'].includes(status);

        if (isCritical) {
            this.pendingUpdates.delete(taskId);
            try {
                await d1.run(
                    "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    [status, errorMsg, Date.now(), taskId]
                );
            } catch (e) {
                console.error(`updateTaskStatus (critical) failed for ${taskId}:`, e);
            }
        } else {
            this.pendingUpdates.set(taskId, { taskId, status, errorMsg, timestamp: Date.now() });
            this.startFlushing();
        }
    }

    /**
     * 标记任务为已取消
     */
    static async markTaskCancelled(taskId) {
        try {
            await d1.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [taskId]);
        } catch (e) {
            console.error(`markTaskCancelled failed for ${taskId}:`, e);
        }
    }

    /**
     * 获取用户最近任务
     */
    static async getRecentTasksByUser(userId, limit = 10) {
        if (!userId) return [];
        try {
            return await d1.fetchAll(
                "SELECT id, file_name, status, error_msg, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
                [userId, limit]
            );
        } catch (e) {
            console.error(`getRecentTasksByUser error for ${userId}:`, e);
            return [];
        }
    }

    /**
     * 根据 msg_id 获取任务组
     */
    static async getTasksByMsgId(msgId) {
        if (!msgId) return [];
        try {
            return await d1.fetchAll(
                "SELECT id, file_name, status, error_msg FROM tasks WHERE msg_id = ? ORDER BY created_at ASC",
                [msgId]
            );
        } catch (e) {
            console.error(`getTasksByMsgId error for ${msgId}:`, e);
            return [];
        }
    }

    /**
     * 检查文件重复
     */
    static async findCompletedTaskByFile(userId, fileName, fileSize) {
        if (!userId || !fileName || fileSize == null) return null;
        try {
            return await d1.fetchOne(
                "SELECT id, status FROM tasks WHERE user_id = ? AND file_name = ? AND file_size = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
                [userId, fileName, fileSize]
            );
        } catch (e) {
            console.error(`findCompletedTaskByFile error for ${userId}/${fileName}:`, e);
            return null;
        }
    }
}