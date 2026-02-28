import PQueue from "p-queue";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { config } from "../config/index.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { ossService } from "../services/oss.js";
import { UIHelper } from "../ui/templates.js";
import { getMediaInfo, updateStatus, escapeHTML, safeEdit } from "../utils/common.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, runMtprotoFileTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { d1 } from "../services/d1.js";
import { cache } from "../services/CacheService.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { queueService } from "../services/QueueService.js";
import { logger } from "../services/logger/index.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { streamTransferService } from "../services/StreamTransferService.js";

const log = logger.withModule('TaskManager');

/**
 * --- 任务管理调度中心 (TaskManager) ---
 * 
 * 核心设计决策：
 * 1. QStash 驱动：移除了传统的基于内存和定时器的 UploadBatcher 机制。
 *    之前版本在高并发和多实例环境下容易出现内存溢出和状态不一致问题。
 *    现在的 QStash 延迟队列方案实现了分布式的批处理和自动重试，具备极高的可靠性。
 * 
 * 2. 状态机驱动：任务状态流转（queued -> downloading -> downloaded -> uploading -> completed）
 *    完全由数据库和消息队列共同保障，支持实例重启后的无损恢复。
 * 负责队列管理、任务恢复、以及具体的下载/上传流程编排
 */
export class TaskManager {
    /**
     * 批量更新任务状态
     * @param {Array<{id: string, status: string, error?: string}>} updates
     */
    static async batchUpdateStatus(updates) {
        if (!updates || updates.length === 0) return;

        const statements = updates.map(({id, status, error}) => ({
            sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = datetime('now') WHERE id = ?",
            params: [status, error || null, id]
        }));

        try {
            await d1.batch(statements);
        } catch (e) {
            log.error("batchUpdateStatus failed", e);
            // 降级到单个更新
            for (const update of updates) {
                try {
                    await TaskRepository.updateStatus(update.id, update.status, update.error);
                } catch (err) {
                    log.error("Failed to update task", { taskId: update.id, error: err });
                }
            }
        }
    }

    // QStash 事件驱动：移除传统队列，改为 Webhook 处理

    // 兼容性：保留原有queue引用
    static get queue() { return this.downloadQueue; }
    static set queue(value) { this.downloadQueue = value; }

    static waitingTasks = [];
    static currentTask = null; // 兼容旧代码：当前正在下载的任务
    static processingUploadTasks = new Set(); // 正在上传的任务
    static waitingUploadTasks = []; // 等待上传的任务队列
    
    // Max queue size limits to prevent unbounded growth
    static MAX_WAITING_TASKS = 1000;
    static MAX_WAITING_UPLOAD_TASKS = 500;
    
    // UI更新节流控制
    static uiUpdateTracker = {
        count: 0,
        windowStart: Date.now(),
        windowSize: 10000, // 10秒窗口
        maxUpdates: 20 // 窗口内最大20次UI更新
    };
    
    /**
     * 获取当前正在处理的任务总数 (下载中 + 上传中)
     */
    static getProcessingCount() {
        let count = 0;
        if (this.currentTask) count++;
        count += this.processingUploadTasks.size;
        return count;
    }

    /**
     * 获取等待中的任务总数 (下载排队 + 上传排队)
     */
    static getWaitingCount() {
        return this.waitingTasks.length + this.waitingUploadTasks.length;
    }
    
    /**
     * Enforce max queue size limits for waiting tasks arrays
     * Removes oldest entries when limits are exceeded
     */
    static enforceQueueSizeLimits() {
        // Trim waitingTasks if over limit
        if (this.waitingTasks.length > this.MAX_WAITING_TASKS) {
            this.waitingTasks = this.waitingTasks.slice(-this.MAX_WAITING_TASKS);
        }
        
        // Trim waitingUploadTasks if over limit
        if (this.waitingUploadTasks.length > this.MAX_WAITING_UPLOAD_TASKS) {
            this.waitingUploadTasks = this.waitingUploadTasks.slice(-this.MAX_WAITING_UPLOAD_TASKS);
        }
    }

    /**
     * @deprecated Use getWaitingCount instead
     */
    static waitingCount() {
        return this.getWaitingCount();
    }

    /**
     * @deprecated Use getProcessingCount instead
     */
    static processingCount() {
        return this.getProcessingCount();
    }

    // 内存中的任务执行锁，防止同一任务被多次 processor 处理
    static activeProcessors = new Set();

    // 运行中任务对象引用（用于取消正在处理的任务）
    static inFlightTasks = new Map(); // taskId -> task object

    // 用户取消标记（用于 QStash 触发前/中途快速拦截）
    static cancelledTaskIds = new Set();

    /**
     * 初始化：恢复因重启中断的僵尸任务
     */
    static async init() {
        log.info("正在检查数据库中异常中断的任务");

        // 安全检查：如果处于 Cache 故障转移模式，延迟任务恢复以优先让主集群处理
        if (cache.isFailoverMode) {
            log.warn("系统处于 Cache 故障转移模式", { cache_provider: 'upstash', delay: 30000 });

            // 先预加载常用数据
            await this._preloadCommonData();

            // 延迟 30 秒
            await new Promise(resolve => setTimeout(resolve, 30000));
            log.info("故障转移实例开始执行延迟恢复检查");
        }

        try {
            // 并行加载初始化数据：僵尸任务 + 预热常用缓存
            // 注意：如果是 failover 模式，commonData 可能已经预加载过了，但再次调用无害（通常有缓存或幂等）
            const results = await Promise.allSettled([
                TaskRepository.findStalledTasks(120000), // 查找 2 分钟未更新的任务
                this._preloadCommonData() 
            ]);

            const tasks = results[0].status === 'fulfilled' ? results[0].value : [];
            // 预加载失败不会影响主流程，只记录日志

            if (!tasks || tasks.length === 0) {
                log.info("没有发现僵尸任务");
                return;
            }

            log.info("发现僵尸任务", { count: tasks.length, action: 'batch_restore' });

            const chatGroups = new Map();
            for (const row of tasks) {
                if (!row.chat_id || row.chat_id.includes("Object")) {
                    log.warn("跳过无效 chat_id 的任务", { taskId: row.id, chatId: row.chat_id });
                    continue;
                }
                if (!chatGroups.has(row.chat_id)) {
                    chatGroups.set(row.chat_id, []);
                }
                chatGroups.get(row.chat_id).push(row);
            }

            // 顺序恢复所有chat groups的任务，避免并发冲击
            for (const [chatId, rows] of chatGroups.entries()) {
                await this._restoreBatchTasks(chatId, rows);
                // 在会话间添加较长的延迟，避免启动时的流量峰值导致 429
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            this.updateQueueUI();
        } catch (e) {
            log.error("TaskManager.init critical error", e);
        }
    }

    /**
     * [私有] 预加载常用数据，提升后续操作性能
     */
    static async _preloadCommonData() {
        const preloadTasks = [];

        try {
            // 并行预加载多个数据源
            preloadTasks.push(
                // 预加载活跃驱动列表（已实现缓存）
                import("../repositories/DriveRepository.js").then(({ DriveRepository }) =>
                    DriveRepository.findAll()
                ),

                // 预加载配置文件缓存
                import("../config/index.js").then(({ config }) => {
                    // 预热配置访问，避免首次访问时的延迟
                    return Promise.resolve(config);
                }),

                // 预加载本地化字符串缓存
                import("../locales/zh-CN.js").then(({ STRINGS }) => {
                    // 预热字符串访问
                    return Promise.resolve(Object.keys(STRINGS).length);
                }),

                // 预加载常用工具函数
                import("../utils/common.js").then(({ getMediaInfo, escapeHTML }) => {
                    // 预热函数引用
                    return Promise.resolve({ getMediaInfo, escapeHTML });
                }),

                // 预热缓存服务
                import("../utils/LocalCache.js").then(({ localCache }) => {
                    // 确保缓存服务已初始化
                    return Promise.resolve(localCache);
                }),

                // 预加载 Cache 服务
                import("../services/CacheService.js").then(({ cache }) => {
                    // 预热 Cache 连接
                    return cache.get("system:health_check", "text").catch(() => "ok");
                })
            );

            // 并行执行所有预加载任务
            const results = await Promise.allSettled(preloadTasks);

            // 统计预加载结果
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            const totalCount = results.length;

            log.info("预加载常用数据完成", { successCount, totalCount });

            // 如果大部分预加载失败，记录警告
            if (successCount < totalCount * 0.7) {
                log.warn("预加载成功率较低", { successCount, totalCount });
            }

        } catch (e) {
            log.warn("预加载数据失败", e);
        }
    }

    /**
     * [私有] 批量恢复同一个会话下的任务
     */
    static async _restoreBatchTasks(chatId, rows) {
        try {
            const sourceMsgIds = rows.map(r => r.source_msg_id);
            const messages = await runMtprotoTaskWithRetry(() => client.getMessages(chatId, { ids: sourceMsgIds }), { priority: PRIORITY.BACKGROUND });

            const messageMap = new Map();
            messages.forEach(m => {
                if (m) messageMap.set(m.id, m);
            });

            // 预处理任务，分离有效和无效任务
            const validTasks = [];
            const failedUpdates = [];
            const tasksToEnqueue = [];
            const tasksToUpload = [];

            // 检查是否为批量任务（同一msg_id下有多个任务）
            const isBatchTask = rows.length > 1;

            for (const row of rows) {
                const message = messageMap.get(row.source_msg_id);
                if (!message || !message.media) {
                    log.warn(`⚠️ 无法找到原始消息 (ID: ${row.source_msg_id})`);
                    failedUpdates.push({ id: row.id, status: 'failed', error: 'Source msg missing' });
                    continue;
                }

                const task = this._createTaskObject(row.id, row.user_id, row.chat_id, row.msg_id, message);
                if (isBatchTask) {
                    task.isGroup = true;
                }
                validTasks.push(task);

                // 根据任务状态决定恢复到哪个队列
                if (row.status === 'downloaded') {
                    // 恢复到上传队列
                    const localPath = path.join(config.downloadDir, row.file_name);
                    if (fs.existsSync(localPath)) {
                        task.localPath = localPath;
                        tasksToUpload.push(task);
                        log.info(`📤 恢复下载完成的任务 ${row.id} 到上传队列`);
                    } else {
                        // 本地文件不存在，重新下载
                        log.warn(`⚠️ 本地文件不存在，重新下载任务 ${row.id}`);
                        tasksToEnqueue.push(task);
                    }
                } else {
                    // 其他状态（queued, downloading）恢复到下载队列
                    tasksToEnqueue.push(task);
                }
            }

            // 批量更新失败状态
            if (failedUpdates.length > 0) {
                await this.batchUpdateStatus(failedUpdates);
            }

            // 限制并发发送恢复消息（使用小批量顺序处理，带UI节流控制）
            const BATCH_SIZE = 2; // 减小批量大小
            for (let i = 0; i < validTasks.length; i += BATCH_SIZE) {
                const batch = validTasks.slice(i, i + BATCH_SIZE);
                const recoveryPromises = batch.map(task =>
                    this.canUpdateUI() 
                        ? updateStatus(task, "🔄 **系统重启，检测到任务中断，已自动恢复...**")
                        : Promise.resolve() // 跳过UI更新
                );
                await Promise.allSettled(recoveryPromises);
                // 增加小批量间延迟，减少API压力
                if (i + BATCH_SIZE < validTasks.length) {
                    await new Promise(resolve => setTimeout(resolve, 1500)); // 从500ms增加到1500ms
                }
            }

            // 批量入队下载任务
            tasksToEnqueue.forEach(task => this._enqueueTask(task));

            // 批量入队上传任务
            tasksToUpload.forEach(task => this._enqueueUploadTask(task));

        } catch (e) {
            log.error(`批量恢复会话 ${chatId} 的任务失败:`, e);
        }
    }

    /**
     * 添加新任务到队列
     */
    static async addTask(target, mediaMessage, userId, customLabel = "") {
        const taskId = randomUUID();
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        const statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.captured, { label: customLabel }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_${taskId}`))],
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            10
        );

        const info = getMediaInfo(mediaMessage);

        try {
            await TaskRepository.create({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceMsgId: mediaMessage.id,
                fileName: info?.name,
                fileSize: info?.size
            });

            // 立即推送到 QStash 队列
            const task = this._createTaskObject(taskId, userId, chatIdStr, statusMsg.id, mediaMessage);
            await this._enqueueTask(task);
            log.info("Task created and enqueued", { taskId, status: 'enqueued' });

        } catch (e) {
            log.error("Task creation failed", e);
            // 尝试更新状态消息，如果失败则记录但不抛出异常
            try {
                await client.editMessage(target, {
                    message: statusMsg.id,
                    text: STRINGS.task.create_failed
                });
            } catch (editError) {
                log.warn("Failed to update error message", { error: editError.message });
            }
        }
    }

    /**
     * 批量添加媒体组任务
     */
    static async addBatchTasks(target, messages, userId) {
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        let statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.batch_captured, { count: messages.length }),
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            10
        );

        // 使用状态消息 msgId 作为批量取消标识，需在消息发送后更新按钮
        try {
            const updatedMsg = await runBotTaskWithRetry(
                () => client.editMessage(target, {
                    message: statusMsg.id,
                    text: format(STRINGS.task.batch_captured, { count: messages.length }),
                    buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_msg_${statusMsg.id}`))],
                    parseMode: "html"
                }),
                userId,
                { priority: PRIORITY.UI },
                false,
                3
            );
            if (updatedMsg) statusMsg = updatedMsg;
        } catch (e) {
            log.warn("Failed to add cancel button to batch message", e);
        }

        const tasksData = [];

        for (const msg of messages) {
            const taskId = randomUUID();
            const info = getMediaInfo(msg);

            tasksData.push({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceMsgId: msg.id,
                fileName: info?.name,
                fileSize: info?.size
            });
        }

        await TaskRepository.createBatch(tasksData);
        // 立即推送到 QStash 队列
        for (const data of tasksData) {
            const message = messages.find(m => m.id === data.sourceMsgId);
            if (message) {
                const task = this._createTaskObject(data.id, data.userId, data.chatId, data.msgId, message);
                task.isGroup = true;
                await this._enqueueTask(task);
            }
        }
        log.info("Batch tasks created and enqueued", { count: messages.length, status: 'enqueued' });
    }

    /**
     * [私有] 标准化构造内存中的任务对象
     */
    static _createTaskObject(id, userId, chatId, msgId, message) {
        const info = getMediaInfo(message);
        return {
            id,
            userId: userId.toString(),
            chatId: chatId.toString(),
            msgId,
            message,
            fileName: info?.name || 'unknown',
            lastText: "",
            isCancelled: false
        };
    }

    /**
     * [私 evasion] 发布任务到 QStash 下载队列
     */
    static async _enqueueTask(task) {
        try {
            // 添加触发源信息
            const taskPayload = {
                userId: task.userId,
                chatId: task.chatId,
                msgId: task.msgId,
                _meta: {
                    triggerSource: 'direct-qstash', // 标识是直接通过 QStash 发送
                    instanceId: process.env.INSTANCE_ID || 'unknown',
                    timestamp: Date.now(),
                    source: 'TaskManager._enqueueTask'
                }
            };

            await queueService.enqueueDownloadTask(task.id, taskPayload);
            log.info("Task enqueued for download", { 
                taskId: task.id, 
                service: 'qstash',
                triggerSource: 'direct-qstash'
            });
        } catch (error) {
            log.error("Failed to enqueue download task", { taskId: task.id, error });
        }
    }

    /**
     * [私ia] 发布任务到 QStash 上传队列
     */
    static async _enqueueUploadTask(task) {
        try {
            await queueService.enqueueUploadTask(task.id, {
                userId: task.userId,
                chatId: task.chatId,
                msgId: task.msgId,
                localPath: task.localPath
            });
            log.info("Task enqueued for upload", { taskId: task.id, service: 'qstash' });
        } catch (error) {
            log.error("Failed to enqueue upload task", { taskId: task.id, error });
        }
    }

    /**
     * 检查是否允许UI更新（节流控制）
     */
    static canUpdateUI() {
        const now = Date.now();
        const tracker = this.uiUpdateTracker;
        
        // 重置窗口
        if (now - tracker.windowStart > tracker.windowSize) {
            tracker.count = 0;
            tracker.windowStart = now;
        }
        
        // 检查是否超过限制
        if (tracker.count >= tracker.maxUpdates) {
            return false;
        }
        
        tracker.count++;
        return true;
    }

    /**
     * 批量更新排队中的 UI（带节流控制）
     */
    static async updateQueueUI() {
        // 获取快照以避免在循环中由于数组变动导致 index 越界
        const snapshot = [...this.waitingTasks];
        const maxTasks = Math.min(snapshot.length, 5);
        
        for (let i = 0; i < maxTasks; i++) {
            const task = snapshot[i];
            if (!task || task.isGroup) continue;

            const newText = format(STRINGS.task.queued, { rank: i + 1 });

            if (task.lastText !== newText && this.canUpdateUI()) {
                await updateStatus(task, newText);
                task.lastText = newText;
                // 添加延迟避免 API 限制，但使用更高效的 Promise.race 控制并发
                if (i < maxTasks - 1) { // 最后一次不需要延迟
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }
        }
    }

    /**
     * [私有] 错误分类函数 - 根据错误类型返回对应的 HTTP 状态码
     * @param {Error} error - 错误对象
     * @returns {number} HTTP 状态码
     */
    static _classifyError(error) {
        const msg = error.message || '';
        const code = error.code || '';
        
        // 任务不存在或无效参数 -> 404
        if (msg.includes('not found') || msg.includes('not found in database') || 
            msg.includes('Source msg missing') || msg.includes('Local file not found') ||
            msg.includes('invalid') || msg.includes('invalid task')) {
            return 404;
        }
        
        // Telegram 或网络超时 -> 503 (Service Unavailable)
        if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('ETIMEDOUT') ||
            msg.includes('network') || msg.includes('Network') || 
            msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') ||
            msg.includes('getaddrinfo') || msg.includes('rate limit') || msg.includes('429')) {
            return 503;
        }
        
        // Cache/锁相关 -> 503
        if (msg.includes('lock') || msg.includes('Lock') || 
            msg.includes('cache') || msg.includes('Cache') || 
            msg.includes('kv') || msg.includes('KV') ||
            msg.includes('upstash') || msg.includes('Upstash') ||
            msg.includes('cloudflare') || msg.includes('Cloudflare')) {
            return 503;
        }
        
        // DB 操作失败 -> 500
        if (msg.includes('database') || msg.includes('Database') || 
            msg.includes('d1') || msg.includes('D1') || 
            msg.includes('sql') || msg.includes('SQL') ||
            msg.includes('batch') || msg.includes('update')) {
            return 500;
        }
        
        // 其他内部错误 -> 500
        return 500;
    }

    /**
     * 处理下载 Webhook - QStash 事件驱动
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async handleDownloadWebhook(taskId) {
        // Leader 状态校验：只有持有 telegram_client 锁的实例才能处理任务
        if (!(await instanceCoordinator.hasLock("telegram_client"))) {
            return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
        }

        try {
            // 从数据库获取任务信息
            const dbTask = await TaskRepository.findById(taskId);
            const triggerSource = dbTask?.source_data?._meta?.triggerSource || 'unknown';
            const instanceId = dbTask?.source_data?._meta?.instanceId || 'unknown';
            
            log.info(`QStash Received download webhook for Task: ${taskId}`, {
                triggerSource, // 'direct-qstash' 或 'unknown'
                instanceId,
                isFromQStash: triggerSource === 'direct-qstash'
            });
            if (!dbTask) {
                log.error(`❌ Task ${taskId} not found in database`);
                return { success: false, statusCode: 404, message: "Task not found" };
            }

            // 用户已取消：直接 ACK（防止 QStash 重试/继续处理）
            if (dbTask.status === 'cancelled') {
                log.info("Task cancelled, skipping download webhook", { taskId });
                return { success: true, statusCode: 200 };
            }

            // 获取原始消息
            const messages = await runMtprotoTaskWithRetry(
                () => client.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                { priority: PRIORITY.BACKGROUND }
            );
            const message = messages[0];
            if (!message || !message.media) {
                await TaskRepository.updateStatus(taskId, 'failed', 'Source msg missing');
                return { success: false, statusCode: 404, message: "Source message missing" };
            }

            // 创建任务对象
            const task = this._createTaskObject(taskId, dbTask.user_id, dbTask.chat_id, dbTask.msg_id, message);
            task.fileName = dbTask.file_name;

            // 检查是否属于组任务（通过 msgId 查询同组任务数量）
            try {
                const siblings = await TaskRepository.findByMsgId(dbTask.msg_id);
                if (siblings && siblings.length > 1) {
                    task.isGroup = true;
                }
            } catch (e) {
                log.warn(`Failed to check group status for task ${taskId}`, e);
            }

            // 执行下载逻辑
            await this.downloadTask(task);
            return { success: true, statusCode: 200 };

        } catch (error) {
            log.error("Download webhook failed", { taskId, error });
            const code = this._classifyError(error);
            await TaskRepository.updateStatus(taskId, 'failed', error.message);
            return { success: false, statusCode: code, message: error.message };
        }
    }

    /**
     * 处理上传 Webhook - QStash 事件驱动
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
     static async handleUploadWebhook(taskId) {
        // Leader 状态校验：只有持有 telegram_client 锁 del 实例才能处理任务
        if (!(await instanceCoordinator.hasLock("telegram_client"))) {
            return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
        }

        try {
            // 从数据库获取任务信息
            const dbTask = await TaskRepository.findById(taskId);
            const triggerSource = dbTask?.source_data?._meta?.triggerSource || 'unknown';
            const instanceId = dbTask?.source_data?._meta?.instanceId || 'unknown';
            
            log.info(`QStash Received upload webhook for Task: ${taskId}`, {
                triggerSource, // 'direct-qstash' 或 'unknown'
                instanceId,
                isFromQStash: triggerSource === 'direct-qstash'
            });
            
            if (!dbTask) {
                log.error(`❌ Task ${taskId} not found in database`);
                return { success: false, statusCode: 404, message: "Task not found" };
            }

            // 用户已取消：直接 ACK（防止 QStash 重试/继续处理）
            if (dbTask.status === 'cancelled') {
                log.info("Task cancelled, skipping upload webhook", { taskId });
                return { success: true, statusCode: 200 };
            }

            // 验证本地文件存在
            const localPath = path.join(config.downloadDir, dbTask.file_name);
            if (!fs.existsSync(localPath)) {
                await TaskRepository.updateStatus(taskId, 'failed', 'Local file not found');
                return { success: false, statusCode: 404, message: "Local file not found" };
            }

            // 获取原始消息
            const messages = await runMtprotoTaskWithRetry(
                () => client.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                { priority: PRIORITY.BACKGROUND }
            );
            const message = messages[0];
            if (!message || !message.media) {
                await TaskRepository.updateStatus(taskId, 'failed', 'Source msg missing');
                return { success: false, statusCode: 404, message: "Source message missing" };
            }

            // 创建任务对象
            const task = this._createTaskObject(taskId, dbTask.user_id, dbTask.chat_id, dbTask.msg_id, message);
            task.localPath = localPath;
            task.fileName = dbTask.file_name;

            // 检查是否属于组任务（通过 msgId 查询同组任务数量）
            try {
                const siblings = await TaskRepository.findByMsgId(dbTask.msg_id);
                if (siblings && siblings.length > 1) {
                    task.isGroup = true;
                }
            } catch (e) {
                log.warn(`Failed to check group status for upload task ${taskId}`, e);
            }

            // 执行上传逻辑
            await this.uploadTask(task);
            return { success: true, statusCode: 200 };

        } catch (error) {
            log.error("Upload webhook failed", { taskId, error });
            const code = this._classifyError(error);
            await TaskRepository.updateStatus(taskId, 'failed', error.message);
            return { success: false, statusCode: code, message: error.message };
        }
    }

    /**
     * 手动重试任务 - 用于处理卡住/失败的任务
     * @param {string} taskId - 任务ID
     * @param {string} type - 重试类型: 'download', 'upload', 'auto' (默认)
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async retryTask(taskId, type = 'auto') {
        try {
            // 1. 获取任务信息
            const dbTask = await TaskRepository.findById(taskId);
            if (!dbTask) {
                return { success: false, statusCode: 404, message: "Task not found" };
            }

            // 2. 检查任务状态
            if (dbTask.status === 'completed') {
                return { success: false, statusCode: 400, message: "Task already completed" };
            }

            if (dbTask.status === 'cancelled') {
                return { success: false, statusCode: 400, message: "Task is cancelled" };
            }

            // 3. 根据类型决定重试逻辑
            if (type === 'auto') {
                // 自动判断：如果任务状态是 'downloaded'，则重试上传；否则重试下载
                if (dbTask.status === 'downloaded') {
                    return await this._retryUpload(taskId, dbTask);
                } else {
                    return await this._retryDownload(taskId, dbTask);
                }
            } else if (type === 'upload') {
                return await this._retryUpload(taskId, dbTask);
            } else if (type === 'download') {
                return await this._retryDownload(taskId, dbTask);
            }

        } catch (error) {
            log.error(`Failed to retry task ${taskId}:`, error);
            return { success: false, statusCode: 500, message: error.message };
        }
    }

    /**
     * 重试下载任务
     * @param {string} taskId - 任务ID
     * @param {Object} dbTask - 数据库任务对象
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async _retryDownload(taskId, dbTask) {
        try {
            // 1. 检查是否需要重新获取消息
            const messages = await runMtprotoTaskWithRetry(
                () => client.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                { priority: PRIORITY.BACKGROUND }
            );
            const message = messages[0];
            if (!message || !message.media) {
                await TaskRepository.updateStatus(taskId, 'failed', 'Source msg missing');
                return { success: false, statusCode: 404, message: "Source message missing" };
            }

            // 2. 创建任务对象
            const task = this._createTaskObject(taskId, dbTask.user_id, dbTask.chat_id, dbTask.msg_id, message);
            task.fileName = dbTask.file_name;

            // 3. 重新入队
            await this._enqueueTask(task);

            // 4. 更新状态
            await TaskRepository.updateStatus(taskId, 'queued');

            return { success: true, statusCode: 200, message: "Task re-enqueued for download" };
        } catch (error) {
            log.error(`Failed to retry download for task ${taskId}:`, error);
            return { success: false, statusCode: 500, message: error.message };
        }
    }

    /**
     * 重试上传任务
     * @param {string} taskId - 任务ID
     * @param {Object} dbTask - 数据库任务对象
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async _retryUpload(taskId, dbTask) {
        try {
            // 1. 检查本地文件是否存在
            const localPath = path.join(config.downloadDir, dbTask.file_name);
            if (!fs.existsSync(localPath)) {
                // 如果文件不存在，回退到重新下载
                return await this._retryDownload(taskId, dbTask);
            }

            // 2. 获取原始消息
            const messages = await runMtprotoTaskWithRetry(
                () => client.getMessages(dbTask.chat_id, { ids: [dbTask.source_msg_id] }),
                { priority: PRIORITY.BACKGROUND }
            );
            const message = messages[0];
            if (!message || !message.media) {
                return { success: false, statusCode: 404, message: "Source message missing" };
            }

            // 3. 创建任务对象
            const task = this._createTaskObject(taskId, dbTask.user_id, dbTask.chat_id, dbTask.msg_id, message);
            task.localPath = localPath;
            task.fileName = dbTask.file_name;

            // 4. 重新入队上传
            await this._enqueueUploadTask(task);

            // 5. 更新状态
            await TaskRepository.updateStatus(taskId, 'downloaded');

            return { success: true, statusCode: 200, message: "Task re-enqueued for upload" };
        } catch (error) {
            log.error(`Failed to retry upload for task ${taskId}:`, error);
            return { success: false, statusCode: 500, message: error.message };
        }
    }

    /**
     * 处理媒体组批处理 Webhook - QStash 事件驱动
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async handleMediaBatchWebhook(groupId, taskIds) {
        try {
            log.info(`QStash Received media-batch webhook for Group: ${groupId}, TaskCount: ${taskIds.length}`);

            // 这里可以实现批处理逻辑，目前先逐个处理
            for (const taskId of taskIds) {
                const result = await this.handleDownloadWebhook(taskId);
                if (!result.success) {
                    // 如果任何一个失败，返回第一个错误
                    return result;
                }
            }
            return { success: true, statusCode: 200 };

        } catch (error) {
            log.error("Media batch webhook failed", { groupId, error });
            const code = this._classifyError(error);
            return { success: false, statusCode: code, message: error.message };
        }
    }

    /**
     * 下载Task - 负责MTProto下载阶段
     */
    static async downloadTask(task) {
        const { message, id } = task;
        if (!message.media) return;

        // 分布式锁：尝试获取任务锁，确保多实例下同一任务不会被重复处理
        const lockAcquired = await instanceCoordinator.acquireTaskLock(id);
        if (!lockAcquired) {
            log.info("Task lock exists, skipping download", { taskId: id, instance: 'current' });
            return;
        }

        let didActivate = false;

        try {
            // 防重入：检查任务是否已经在处理中
            if (this.activeProcessors.has(id)) {
                log.warn("Task already processing, skipping download", { taskId: id });
                return;
            }
            this.activeProcessors.add(id);
            this.inFlightTasks.set(id, task);
            didActivate = true;

            this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
            this.updateQueueUI();

            const info = getMediaInfo(message.media);
            if (!info) {
                this.activeProcessors.delete(id);
                return await updateStatus(task, STRINGS.task.parse_failed, true);
            }

            // 使用任务中已有的文件名（保持一致性），如果不存在则使用 info.name
            const fileName = task.fileName || info.name;
            const localPath = path.join(config.downloadDir, fileName);
            task.localPath = localPath;

            let lastUpdate = 0;
            const heartbeat = async (status, downloaded = 0, total = 0) => {
                // 原子性检查：先获取标志，再检查
                const isCancelled = this.cancelledTaskIds.has(task.id);
                if (isCancelled) {
                    task.isCancelled = true;
                    throw new Error("CANCELLED");
                }
                
                // 异步更新数据库状态，不阻塞 UI 响应
                void TaskRepository.updateStatus(task.id, status).catch(e => log.warn("DB status update failed", e));

                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, status, downloaded, total);
                } else {
                    const text = (downloaded > 0)
                        ? UIHelper.renderProgress(downloaded, total, STRINGS.task.downloading, fileName)
                        : STRINGS.task.downloading;
                    
                    await updateStatus(task, text);
                }
            };

            try {
                // 1. 并发处理：异步发起 UI 更新，不阻塞秒传检查和下载准备
                const initialHeartbeat = heartbeat('downloading', 0, 0)
                    .catch(e => log.warn("Initial heartbeat failed", e));
                
                // 2. 优先检查远程秒传 (使用快速检查模式：不重试，跳过回退)
                const remoteFile = await CloudTool.getRemoteFileInfo(fileName, task.userId, 1, true);

                if (remoteFile && this._isSizeMatch(remoteFile.Size, info.size)) {
                    // 秒传命中，确保 UI 更新完成后再显示成功
                    await initialHeartbeat; 
                    await TaskRepository.updateStatus(task.id, 'completed');

                    if (task.isGroup) {
                        await this._refreshGroupMonitor(task, 'completed');
                    } else {
                        const actualUploadPath = await CloudTool._getUploadPath(task.userId);
                        const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                        const fileNameHtml = `<a href="${fileLink}">${escapeHTML(fileName)}</a>`;
                        await updateStatus(task, format(STRINGS.task.success_sec_transfer, { name: fileNameHtml, folder: actualUploadPath }), true);
                    }
                    this.activeProcessors.delete(id);
                    // 秒传完成，无需上传
                    return;
                }

                // 2. 本地文件检查 (断点续传或利用本地缓存)
                let localFileExists = false;
                let localFileSize = 0;

                try {
                    const stats = await fs.promises.stat(localPath);
                    localFileExists = true;
                    localFileSize = stats.size;
                } catch (e) {
                    // 文件不存在，继续下载
                }

                // 如果本地文件已存在且完整，跳过下载，直接进入上传流程
                if (localFileExists && this._isSizeMatch(localFileSize, info.size)) {
                    // 本地文件完好，直接触发上传 Webhook
                    await TaskRepository.updateStatus(task.id, 'downloaded');
                    if (!task.isGroup) {
                        await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
                    }
                    this.activeProcessors.delete(id);
                    await queueService.enqueueUploadTask(task.id, {
                        userId: task.userId,
                        chatId: task.chatId,
                        msgId: task.msgId,
                        localPath: task.localPath
                    });
                    log.info("Local file exists, triggered upload webhook", { taskId: task.id });
                    return;
                }

                const isLargeFile = info.size > 100 * 1024 * 1024;

                // 3. 检查是否开启流式转发模式
                const activeInstances = (await instanceCoordinator.getActiveInstances?.()) || [];
                const otherInstances = activeInstances.filter(inst => inst.id !== instanceCoordinator.instanceId);
                const streamEnabled = config.streamForwarding?.enabled && otherInstances.length > 0;

                // 流式传输状态日志
                if (streamEnabled) {
                    log.info(`🚀 流式传输已启用！任务：${task.id} (${task.fileName})`, {
                        configEnabled: config.streamForwarding?.enabled,
                        otherInstancesCount: otherInstances.length,
                        activeInstances: activeInstances.map(i => i.id),
                        currentInstance: instanceCoordinator.instanceId,
                        lbUrl: config.streamForwarding?.lbUrl,
                        externalUrl: config.streamForwarding?.externalUrl
                    });
                } else {
                    const reason = config.streamForwarding?.enabled
                        ? '❌ 无其他活跃实例'
                        : '❌ 配置未启用';
                        
                    log.info(`⚠️ 流式传输未启用！任务：${task.id} (${task.fileName})，原因：${reason}`, {
                        configStatus: config.streamForwarding,
                        activeInstancesCount: activeInstances.length,
                        otherInstancesCount: otherInstances.length,
                        currentInstance: instanceCoordinator.instanceId
                    });
                }

                if (streamEnabled) {
                    let targetUrl = config.streamForwarding.lbUrl;
                    if (!targetUrl) {
                        const bestWorker = otherInstances.sort((a, b) => (a.activeTaskCount || 0) - (b.activeTaskCount || 0))[0];
                        if (bestWorker) targetUrl = bestWorker.tunnelUrl || bestWorker.url;
                    }

                    if (targetUrl) {
                        try {
                            log.info(`🚀 开启流式转发模式: Task ${task.id}, Target: ${targetUrl}`);
                            await updateStatus(task, "🚀 **正在通过流式转发上传...**");

                            const { tunnelService } = await import("../services/TunnelService.js");
                            const tunnelUrl = await tunnelService.getPublicUrl();
                            const leaderUrl = tunnelUrl || config.streamForwarding.externalUrl || `http://localhost:${config.port}`;

                            // 断点续传：检查是否可以恢复
                            let chunkIndex = 0;
                            let resumeInfo = null;
                            
                            try {
                                // 查询Worker端的进度
                                const progressUrl = `${targetUrl.replace(/\/$/, '')}/api/v2/stream/${task.id}/full-progress`;
                                const progressResponse = await fetch(progressUrl, {
                                    method: 'GET',
                                    headers: {
                                        'x-instance-secret': config.streamForwarding.secret
                                    }
                                });
                                
                                if (progressResponse.ok) {
                                    const progressData = await progressResponse.json();
                                    if (progressData.isCached || progressData.isActive) {
                                        chunkIndex = progressData.lastChunkIndex + 1;
                                        resumeInfo = progressData;
                                        log.info(`🔄 断点续传: 从 chunk ${chunkIndex} 恢复任务 ${task.id}`);
                                        await updateStatus(task, `🔄 **断点续传中... (从 ${(progressData.uploadedBytes / 1024 / 1024).toFixed(2)}MB 恢复)**`);
                                    }
                                }
                            } catch (resumeError) {
                                log.debug(`断点续传检查失败，将从头开始: ${resumeError.message}`);
                            }

                            // 创建下载迭代器
                            const downloadIterator = client.iterDownload({
                                file: message.media,
                                requestSize: isLargeFile ? 512 * 1024 : 128 * 1024
                            });

                            // 如果是断点续传，需要跳过已传输的chunk
                            if (resumeInfo && chunkIndex > 0) {
                                log.info(`⏭️ 跳过前 ${chunkIndex} 个 chunk (断点续传)`);
                                for (let i = 0; i < chunkIndex; i++) {
                                    await downloadIterator.next();
                                    // 更新下载进度以保持一致
                                    const downloaded = Math.min((i + 1) * (isLargeFile ? 512 * 1024 : 128 * 1024), info.size);
                                    if (i % 20 === 0) {
                                        await updateStatus(task, UIHelper.renderProgress(downloaded, info.size, "⏭️ 跳过已传输部分...", fileName));
                                    }
                                }
                            }

                            // 继续传输剩余的chunk
                            for await (const chunk of downloadIterator) {
                                if (this.cancelledTaskIds.has(task.id)) throw new Error("CANCELLED");
                                const isLast = chunkIndex * (isLargeFile ? 512 * 1024 : 128 * 1024) + chunk.length >= info.size;
                                
                                await streamTransferService.forwardChunk(task.id, chunk, {
                                    fileName, userId: task.userId, chunkIndex, isLast, 
                                    totalSize: info.size, leaderUrl, chatId: task.chatId, msgId: task.msgId, 
                                    sourceMsgId: task.message.id, targetUrl
                                });
                                
                                const downloaded = chunkIndex * (isLargeFile ? 512 * 1024 : 128 * 1024) + chunk.length;
                                if (chunkIndex % 20 === 0 || isLast) {
                                    const statusText = resumeInfo ? "🔄 断点续传中..." : "📥 正在转发流...";
                                    await updateStatus(task, UIHelper.renderProgress(downloaded, info.size, statusText, fileName));
                                }
                                chunkIndex++;
                            }
                            log.info(`✅ 流式转发完成: Task ${task.id}`);
                            this.activeProcessors.delete(id);
                            return;
                        } catch (e) {
                            if (e.message === "CANCELLED") throw e;
                            log.error(`❌ 流式转发失败，正在回退到本地下载模式: ${e.message}`);
                        }
                    }
                }

                // 下载阶段 - MTProto文件下载
                const downloadOptions = {
                    outputFile: localPath,
                    chunkSize: isLargeFile ? 512 * 1024 : 128 * 1024,
                    workers: isLargeFile ? 3 : 1,
                    progressCallback: async (downloaded, total) => {
                        const now = Date.now();
                        if (now - lastUpdate > 3000 || downloaded === total) {
                            lastUpdate = now;
                            await heartbeat('downloading', downloaded, total);
                        }
                    }
                };


                await runMtprotoFileTaskWithRetry(() => client.downloadMedia(message, downloadOptions), {}, 10); // 增加重试次数到10次

                // 下载完成，推入上传队列
                await TaskRepository.updateStatus(task.id, 'downloaded');
                if (!task.isGroup) {
                    await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
                }

                // 触发上传 Webhook
                this.activeProcessors.delete(id);
                await queueService.enqueueUploadTask(task.id, {
                    userId: task.userId,
                    chatId: task.chatId,
                    msgId: task.msgId,
                    localPath: task.localPath
                });
                log.info("Download complete, triggered upload webhook", { taskId: task.id });

            } catch (e) {
                const isCancel = e.message === "CANCELLED";
                try {
                    await TaskRepository.updateStatus(task.id, isCancel ? 'cancelled' : 'failed', e.message);
                } catch (updateError) {
                    log.error(`Failed to update task status for ${task.id}:`, updateError);
                }

                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, isCancel ? 'cancelled' : 'failed');
                } else {
                    const text = isCancel ? STRINGS.task.cancelled : `${STRINGS.task.error_prefix}<code>${escapeHTML(e.message)}</code>`;
                    await updateStatus(task, text, true);
                }
                this.activeProcessors.delete(id);
            }
        } finally {
            if (didActivate) this.inFlightTasks.delete(id);
            // 确保分布式锁被释放
            await instanceCoordinator.releaseTaskLock(id);
        }
    }

    /**
     * 上传Task - 负责rclone转存阶段（无需MTProto）
     */
    static async uploadTask(task) {
        const { id } = task;

        // 分布式锁：尝试获取任务锁，确保多实例下同一任务不会被重复处理
        const lockAcquired = await instanceCoordinator.acquireTaskLock(id);
        if (!lockAcquired) {
            log.info("Task lock exists, skipping upload", { taskId: id, instance: 'current' });
            return;
        }

        let didActivate = false;
        let localPath = null;
        let info = null;

        try {
            // 防重入：上传 Task 也增加检查
            if (this.activeProcessors.has(id)) {
                log.warn("Task already processing, skipping upload", { taskId: id });
                return;
            }
            this.activeProcessors.add(id);
            this.inFlightTasks.set(id, task);
            didActivate = true;

            info = getMediaInfo(task.message.media);
            if (!info) {
                return;
            }

            localPath = task.localPath;
            if (!fs.existsSync(localPath)) {
                await TaskRepository.updateStatus(task.id, 'failed', 'Local file not found');
                const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                const fileNameHtml = `<a href="${fileLink}">${escapeHTML(info.name)}</a>`;
                await updateStatus(task, format(STRINGS.task.failed_validation, { name: fileNameHtml }), true);
                return;
            }

            let lastUpdate = 0;
            const heartbeat = async (status, downloaded = 0, total = 0, uploadProgress = null) => {
                if (this.cancelledTaskIds.has(task.id)) task.isCancelled = true;
                if (task.isCancelled) throw new Error("CANCELLED");
                await TaskRepository.updateStatus(task.id, status);

                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, status, downloaded, total);
                } else {
                    let text;
                    if (status === 'uploading' && uploadProgress) {
                        text = UIHelper.renderProgress(uploadProgress.bytes, uploadProgress.size, STRINGS.task.uploading, info.name);
                    } else {
                        text = STRINGS.task.uploading;
                    }
                    await updateStatus(task, text);
                }
            };

            // 上传前重复检查：如果远程已存在同名且大小匹配的文件，跳过上传
            // 使用快速检查模式：不重试，跳过耗时的目录回退
            const fileName = path.basename(localPath);
            const remoteFile = await CloudTool.getRemoteFileInfo(fileName, task.userId, 1, true);
            
            if (remoteFile && this._isSizeMatch(remoteFile.Size, info.size)) {
                await TaskRepository.updateStatus(task.id, 'completed');
                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, 'completed');
                } else {
                    const actualUploadPath = await CloudTool._getUploadPath(task.userId);
                    const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                    const fileNameHtml = `<a href="${fileLink}">${escapeHTML(fileName)}</a>`;
                    await updateStatus(task, format(STRINGS.task.success_sec_transfer, { name: fileNameHtml, folder: actualUploadPath }), true);
                }
                return;
            }

            // 上传阶段 - 根据驱动类型选择上传方式
            if (!task.isGroup) await updateStatus(task, STRINGS.task.uploading);
            await heartbeat('uploading');

            let uploadResult;
            const isR2Drive = config.remoteName === 'r2' && config.oss?.r2?.bucket;

            if (isR2Drive) {
                // 使用 OSS 服务进行双轨制上传
                log.info(`📤 使用 OSS 服务上传到 R2: ${fileName}`);
                uploadResult = await ossService.upload(localPath, fileName, (progress) => {
                    const now = Date.now();
                    if (now - lastUpdate > 3000) {
                        lastUpdate = now;
                        void heartbeat('uploading', 0, 0, progress).catch((err) => {
                            if (err?.message === "CANCELLED") return;
                            log.warn("Upload heartbeat failed", { taskId: task.id, error: err?.message || String(err) });
                        });
                    }
                }, task.userId);
                // 转换 OSS 结果为期望格式
                uploadResult = uploadResult.success ? { success: true } : { success: false, error: uploadResult.error };
            } else {
                // 使用 rclone 直接上传单个文件
                log.info(`📤 使用 rclone 直接上传: ${fileName}`);
                uploadResult = await CloudTool.uploadFile(localPath, task, (progress) => {
                    const now = Date.now();
                    if (now - lastUpdate > 3000) {
                        lastUpdate = now;
                        void heartbeat('uploading', 0, 0, progress).catch((err) => {
                            if (err?.message === "CANCELLED") return;
                            log.warn("Upload heartbeat failed", { taskId: task.id, error: err?.message || String(err) });
                        });
                    }
                });
            }

            // 结果处理
            if (uploadResult.success) {
                if (!task.isGroup) await updateStatus(task, STRINGS.task.verifying);
                
                // 增加校验前的延迟，应对网盘 API 的最终一致性延迟
                await new Promise(resolve => setTimeout(resolve, 3000));

                // 从实际本地文件路径提取正确文件名
                const actualFileName = path.basename(localPath);

                // 更健壮的文件校验逻辑
                let finalRemote = null;
                let validationAttempts = 0;
                const maxValidationAttempts = 5;

                while (validationAttempts < maxValidationAttempts) {
                    finalRemote = await CloudTool.getRemoteFileInfo(actualFileName, task.userId, 2); // 减少每个校验的内部重试次数
                    if (finalRemote) break;

                    validationAttempts++;
                    if (validationAttempts < maxValidationAttempts) {
                        // 如果是最后一次尝试，强制刷新文件列表缓存
                        if (validationAttempts === maxValidationAttempts - 1) {
                            log.info(`Final attempt for ${actualFileName}, forcing cache refresh...`);
                            try {
                                await CloudTool.listRemoteFiles(task.userId, true); // 强制刷新缓存
                                // 再试一次
                                finalRemote = await CloudTool.getRemoteFileInfo(actualFileName, task.userId, 1);
                                if (finalRemote) break;
                            } catch (e) {
                                log.warn(`Cache refresh failed:`, e);
                            }
                        }

                        log.info(`Attempt ${validationAttempts} failed for ${actualFileName}, retrying in ${validationAttempts * 5}s...`);
                        await new Promise(resolve => setTimeout(resolve, validationAttempts * 5000)); // 递增延迟: 5s, 10s, 15s, 20s
                    }
                }

                const localSize = fs.statSync(localPath).size;
                const isOk = finalRemote && this._isSizeMatch(finalRemote.Size, localSize);

                if (!isOk) {
                    log.error(`Validation Failed - Task: ${task.id}, File: ${actualFileName}`);
                    log.error(`- Local Size: ${localSize}`);
                    log.error(`- Remote Size: ${finalRemote ? finalRemote.Size : 'N/A'}`);
                    log.error(`- Remote Info: ${JSON.stringify(finalRemote)}`);
                    log.error(`- Validation attempts: ${validationAttempts}`);
                }

                const finalStatus = isOk ? 'completed' : 'failed';
                const errorMsg = isOk ? null : `校验失败: 本地(${localSize}) vs 远程(${finalRemote ? finalRemote.Size : '未找到'})`;
                await TaskRepository.updateStatus(task.id, finalStatus, errorMsg);

                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, finalStatus, 0, 0, errorMsg);
                } else {
                    const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                    const fileNameHtml = `<a href="${fileLink}">${escapeHTML(info.name)}</a>`;
                    const baseText = isOk
                        ? format(STRINGS.task.success, { name: fileNameHtml, folder: config.remoteFolder })
                        : format(STRINGS.task.failed_validation, { name: fileNameHtml });
                    
                    const finalMsg = isOk ? baseText : `${baseText}\n<code>${escapeHTML(errorMsg)}</code>`;
                    await updateStatus(task, finalMsg, true);
                }
            } else {
                if (task.isCancelled || uploadResult.error === "CANCELLED") {
                    throw new Error("CANCELLED");
                }

                await TaskRepository.updateStatus(task.id, 'failed', uploadResult.error || "Upload failed");
                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, 'failed', 0, 0, uploadResult.error || "Upload failed");
                } else {
                    await updateStatus(task, format(STRINGS.task.failed_upload, {
                        reason: task.isCancelled ? "用户手动取消" : escapeHTML(uploadResult.error)
                    }), true);
                }
            }
        } catch (e) {
            const isCancel = e.message === "CANCELLED";
            await TaskRepository.updateStatus(task.id, isCancel ? 'cancelled' : 'failed', e.message);

            if (task.isGroup) {
                await this._refreshGroupMonitor(task, isCancel ? 'cancelled' : 'failed');
            } else {
                const text = isCancel ? STRINGS.task.cancelled : `${STRINGS.task.error_prefix}<code>${escapeHTML(e.message)}</code>`;
                await updateStatus(task, text, true);
            }
        } finally {
            // 上传完成后异步清理本地文件
            if (localPath) {
                try {
                    if (fs.promises && fs.promises.unlink) {
                        await fs.promises.unlink(localPath);
                    } else {
                        fs.unlinkSync(localPath);
                    }
                } catch (e) {
                    log.warn(`Failed to cleanup local file ${localPath}:`, e);
                }
            }
            
            // 确保 activeProcessors 被清理
            this.activeProcessors.delete(id);
            
            // 确保 inFlightTasks 被清理
            if (didActivate) {
                this.inFlightTasks.delete(id);
            }
            
            // 确保分布式锁被释放
            await instanceCoordinator.releaseTaskLock(id);
        }
    }

    /**
     * 取消指定任务
     */
    static async cancelTask(taskId, userId) {
        const dbTask = await TaskRepository.findById(taskId);
        if (!dbTask) return false;

        const isOwner = dbTask.user_id === userId.toString();
        const canCancelAny = await AuthGuard.can(userId, "task:cancel:any");

        if (!isOwner && !canCancelAny) return false;

        // 标记取消（用于中途快速拦截）
        this.cancelledTaskIds.add(taskId);

        // 检查下载队列
        const downloadTask = this.waitingTasks.find(t => t.id.toString() === taskId) ||
                            (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);

        if (downloadTask) {
            downloadTask.isCancelled = true;
            if (downloadTask.proc) downloadTask.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
        }

        // 检查上传队列
        const uploadTask = this.waitingUploadTasks.find(t => t.id.toString() === taskId);
        if (uploadTask) {
            uploadTask.isCancelled = true;
            if (uploadTask.proc) uploadTask.proc.kill("SIGTERM");
            this.waitingUploadTasks = this.waitingUploadTasks.filter(t => t.id.toString() !== taskId);
        }

        // 检查运行中任务（QStash / Webhook 驱动）
        const inFlight = this.inFlightTasks.get(taskId);
        if (inFlight) {
            inFlight.isCancelled = true;
            if (inFlight.proc) inFlight.proc.kill("SIGTERM");
        }

        await TaskRepository.updateStatus(taskId, 'cancelled', '用户手动取消');

        // 立即更新 UI（防止用户感觉“没反应”）
        try {
            let peer = dbTask.chat_id;
            if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);
            await safeEdit(peer, parseInt(dbTask.msg_id), STRINGS.task.cancelled, null, userId, "html");
        } catch (e) {
            // safeEdit 内部已兜底，这里不再抛出
        }
        return true;
    }

    /**
     * 按 status 消息 msgId 取消整组任务（媒体组）
     */
    static async cancelTasksByMsgId(msgId, userId) {
        if (!msgId) return false;

        const tasks = await TaskRepository.findByMsgId(msgId);
        if (!tasks.length) return false;

        // 权限：任务属于自己或具备管理员权限
        const canCancelAny = await AuthGuard.can(userId, "task:cancel:any");
        const ownsAll = tasks.every(t => t.user_id === userId.toString());
        if (!ownsAll && !canCancelAny) return false;

        const updates = tasks.map(t => ({ id: t.id, status: 'cancelled', error: '用户手动取消' }));
        await this.batchUpdateStatus(updates);
        tasks.forEach(t => { t.status = 'cancelled'; });

        for (const t of tasks) {
            this.cancelledTaskIds.add(t.id);
            const inFlight = this.inFlightTasks.get(t.id);
            if (inFlight) {
                inFlight.isCancelled = true;
                if (inFlight.proc) inFlight.proc.kill("SIGTERM");
            }
        }

        // 刷新批量看板 UI
        try {
            const meta = tasks[0];
            let peer = meta.chat_id;
            if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);
            const focusTask = { id: meta.id };
            const { text } = UIHelper.renderBatchMonitor(tasks, focusTask, 'cancelled');
            await safeEdit(peer, parseInt(meta.msg_id), text, null, userId, "html");
        } catch (e) {
            // safeEdit 内部已兜底
        }

        return true;
    }

    static monitorLocks = new Map();
    static autoScalingInterval = null;

    /**
     * 启动自动缩放监控
     */
    static startAutoScaling() {
        if (this.autoScalingInterval) return;
        import('../utils/limiter.js').then((limiterModule) => {
            this.autoScalingInterval = setInterval(() => {
                try {
                    const { botGlobalLimiter, mtprotoLimiter, mtprotoFileLimiter } = limiterModule;
                    if (botGlobalLimiter?.adjustConcurrency) botGlobalLimiter.adjustConcurrency();
                    if (mtprotoLimiter?.adjustConcurrency) mtprotoLimiter.adjustConcurrency();
                    if (mtprotoFileLimiter?.adjustConcurrency) mtprotoFileLimiter.adjustConcurrency();
                    
                    // Enforce queue size limits to prevent unbounded growth
                    this.enforceQueueSizeLimits();
                } catch (error) {
                    log.error('Auto-scaling adjustment error:', error);
                }
            }, 30000);
        });
    }

    /**
     * 停止自动缩放监控
     */
    static stopAutoScaling() {
        if (this.autoScalingInterval) {
            clearInterval(this.autoScalingInterval);
            this.autoScalingInterval = null;
        }
    }

    /**
     * [私有] 检查文件大小是否匹配（带动态容差）
     */
    static _isSizeMatch(size1, size2) {
        const diff = Math.abs(size1 - size2);
        const maxSize = Math.max(size1, size2);
        if (maxSize < 1024 * 1024) return diff < 10 * 1024;
        else if (maxSize < 100 * 1024 * 1024) return diff < 1024 * 1024;
        else return diff < 10 * 1024 * 1024;
    }

    /**
     * [私有] 刷新组任务看板 (智能节流)
     */
    static async _refreshGroupMonitor(task, status, downloaded = 0, total = 0, errorMsg = null) {
        const msgId = task.msgId;
        const lastUpdate = this.monitorLocks.get(msgId) || 0;
        const now = Date.now();
        const isFinal = status === 'completed' || status === 'failed' || status === 'cancelled';

        if (now - lastUpdate < 2000 && !isFinal) return;
        this.monitorLocks.set(msgId, now);

        const groupTasks = await TaskRepository.findByMsgId(msgId);
        if (!groupTasks.length) return;

        const { text } = UIHelper.renderBatchMonitor(groupTasks, task, status, downloaded, total, errorMsg);

        let peer = task.chatId;
        if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);

        await safeEdit(peer, parseInt(task.msgId), text, null, task.userId, "html");
    }

}