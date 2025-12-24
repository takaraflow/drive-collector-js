import { d1 } from "../services/d1.js";

/**
 * 任务数据仓储层
 * 负责与 'tasks' 表进行交互，隔离 SQL 细节
 */
export class TaskRepository {
    /**
     * 创建新任务
     * @param {Object} taskData - 任务数据对象
     * @param {string} taskData.id - 任务唯一ID
     * @param {string} taskData.userId - 用户ID
     * @param {string} taskData.chatId - 会话ID
     * @param {number} taskData.msgId - 状态消息ID
     * @param {number} taskData.sourceMsgId - 原始消息ID
     * @param {string} taskData.fileName - 文件名
     * @param {number} taskData.fileSize - 文件大小
     * @returns {Promise<boolean>} 是否插入成功
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
     * @param {number} timeoutMs - 超时阈值（毫秒）
     * @returns {Promise<Array>} 任务列表
     */
    static async findStalledTasks(timeoutMs) {
        // 使用防御性编程：确保 timeoutMs 是正整数
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
     * @param {string} taskId 
     * @returns {Promise<Object|null>}
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
     * 更新任务状态和心跳
     * @param {string} taskId 
     * @param {string} status - 新状态
     * @param {string|null} errorMsg - 错误信息（可选）
     * @returns {Promise<void>}
     */
    static async updateStatus(taskId, status, errorMsg = null) {
        try {
            // 更新 updated_at 相当于“心跳”，证明进程还活着
            await d1.run(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                [status, errorMsg, Date.now(), taskId]
            );
        } catch (e) {
            // 这里吞掉错误是防止数据库抖动导致整个任务流程崩溃，但会记录日志
            console.error(`TaskRepository.updateStatus failed for ${taskId}:`, e);
        }
    }

    /**
     * 标记任务为已取消
     * @param {string} taskId 
     * @returns {Promise<void>}
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
     * @param {number} msgId 
     * @returns {Promise<Array>}
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
     * @param {Array<Object>} tasksData 
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