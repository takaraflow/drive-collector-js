import PQueue from "p-queue";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { dependencyContainer } from "../services/DependencyContainer.js";

// 导入模块化的方法
import { downloadTask } from "./TaskManager/TaskManager.download.js";
import { uploadTask } from "./TaskManager/TaskManager.upload.js";

// 获取依赖项的辅助函数
const getDeps = () => dependencyContainer.getAll();
const getLog = () => getDeps().logger.withModule('TaskManager');

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
        const { d1, TaskRepository } = getDeps();
        const log = getLog();

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
        const { cache, TaskRepository } = getDeps();
        const log = getLog();
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
        const log = getLog();
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
        const { client, runMtprotoTaskWithRetry, PRIORITY, config } = getDeps();
        const log = getLog();
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
        const { client, format, STRINGS, PRIORITY, TaskRepository, getMediaInfo, runBotTaskWithRetry } = getDeps();
        const log = getLog();
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
        const { client, format, STRINGS, PRIORITY, TaskRepository, getMediaInfo, runBotTaskWithRetry } = getDeps();
        const log = getLog();
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
        const { getMediaInfo } = getDeps();
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
        const { queueService } = getDeps();
        const log = getLog();
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
        const { queueService } = getDeps();
        const log = getLog();
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
        const { format, STRINGS, updateStatus } = getDeps();
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
        const { instanceCoordinator, TaskRepository, client, runMtprotoTaskWithRetry, PRIORITY } = getDeps();
        const log = getLog();
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
        const { instanceCoordinator, TaskRepository, client, runMtprotoTaskWithRetry, PRIORITY, config } = getDeps();
        const log = getLog();
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
        const { TaskRepository } = getDeps();
        const log = getLog();
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
        const { client, runMtprotoTaskWithRetry, PRIORITY, TaskRepository } = getDeps();
        const log = getLog();
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
        const { client, runMtprotoTaskWithRetry, PRIORITY, config, TaskRepository } = getDeps();
        const log = getLog();
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
        const log = getLog();
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
        return downloadTask.call(this, task);
    }

    /**
     * 上传Task - 负责rclone转存阶段（无需MTProto）
     */
    static async uploadTask(task) {
        return uploadTask.call(this, task);
    }

    /**
     * 取消指定任务
     */
    static async cancelTask(taskId, userId) {
        const { TaskRepository, AuthGuard, safeEdit, STRINGS } = getDeps();
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
        const { TaskRepository, AuthGuard, UIHelper, safeEdit } = getDeps();
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
        const log = getLog();
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
        const { TaskRepository, UIHelper, safeEdit } = getDeps();
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
