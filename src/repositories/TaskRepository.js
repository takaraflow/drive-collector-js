import { d1 } from "../services/d1.js";

/**
 * 任务数据仓储层
 * 负责与 'tasks' 表进行交互，隔离 SQL 细节
 */
export class TaskRepository {
    static pendingUpdates = new Map();
    static flushTimer = null;

    /**
     * 启动定时刷新任务
     */
    static startFlushing() {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => this.flushUpdates(), 10000); // 每 10 秒刷新一次
    }

    /**
     * 将积压的更新批量写入数据库
     * 每次最多处理 50 条，防止并发请求过多阻塞网络导致 Telegram 连接断开
     */
    static async flushUpdates() {
        if (this.pendingUpdates.size === 0) return;

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
                    console.error(`Task flush failed for ${update.taskId}:`, res.error);
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
            console.error("TaskRepository.flushUpdates critical error:", error);
        }
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
            console.error(`TaskRepository.create failed for ${taskData.id}:`, e);
            throw e;
        }
    }

    /**
     * 查找所有“僵尸”任务（长时间未更新的任务）
     */
    static async findStalledTasks(timeoutMs) {
        const safeTimeout = Math.max(0, timeoutMs || 0);
        const deadLine = Date.now() - safeTimeout;

        try {
            return await d1.fetchAll(
                `SELECT * FROM tasks 
                WHERE status IN ('queued', 'downloading', 'uploading') 
                AND (updated_at IS NULL OR updated_at < ?) 
                ORDER BY created_at ASC`,
                [deadLine]
            );
        } catch (e) {
            console.error("TaskRepository.findStalledTasks error:", e);
            return [];
        }
    }

    /**
     * 根据 ID 获取任务
     */
    static async findById(taskId) {
        if (!taskId) return null;
        try {
            return await d1.fetchOne("SELECT * FROM tasks WHERE id = ?", [taskId]);
        } catch (e) {
            console.error(`TaskRepository.findById error for ${taskId}:`, e);
            return null;
        }
    }

    /**
     * 更新任务状态和心跳 (内存缓冲版)
     */
    static async updateStatus(taskId, status, errorMsg = null) {
        const isCritical = ['completed', 'failed', 'cancelled'].includes(status);

        if (isCritical) {
            this.pendingUpdates.delete(taskId);
            try {
                await d1.run(
                    "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    [status, errorMsg, Date.now(), taskId]
                );
            } catch (e) {
                console.error(`TaskRepository.updateStatus (critical) failed for ${taskId}:`, e);
            }
        } else {
            this.pendingUpdates.set(taskId, { taskId, status, errorMsg });
            this.startFlushing();
        }
    }

    /**
     * 标记任务为已取消
     */
    static async markCancelled(taskId) {
        try {
            await d1.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [taskId]);
        } catch (e) {
            console.error(`TaskRepository.markCancelled failed for ${taskId}:`, e);
        }
    }

    /**
     * 根据 msg_id 获取该消息组下的所有任务状态（用于看板）
     */
    static async findByMsgId(msgId) {
        if (!msgId) return [];
        try {
            return await d1.fetchAll(
                "SELECT file_name, status FROM tasks WHERE msg_id = ? ORDER BY created_at ASC", 
                [msgId]
            );
        } catch (e) {
            console.error(`TaskRepository.findByMsgId error for ${msgId}:`, e);
            return [];
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
            console.error("TaskRepository.createBatch failed:", e);
            throw e;
        }
    }
}