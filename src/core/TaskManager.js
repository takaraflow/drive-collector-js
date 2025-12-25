import PQueue from "p-queue";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { config } from "../config/index.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { UIHelper } from "../ui/templates.js";
import { getMediaInfo, updateStatus, escapeHTML, safeEdit } from "../utils/common.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, runMtprotoFileTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { d1 } from "../services/d1.js";
import { STRINGS, format } from "../locales/zh-CN.js";

/**
 * 上传聚合器：负责收集已下载完成的任务，并分批触发批量上传
 */
class UploadBatcher {
    constructor(processBatchFn) {
        this.batches = new Map(); // key: userId_folder -> [tasks]
        this.processBatchFn = processBatchFn;
        this.waitWindow = 5000; // 5秒等待窗口
    }

    /**
     * 添加任务到聚合池
     */
    add(task) {
        const key = `${task.userId}_${config.remoteFolder}`;
        if (!this.batches.has(key)) {
            this.batches.set(key, []);
            // 开启该分组的计时器
            setTimeout(() => this.trigger(key), this.waitWindow);
        }
        this.batches.get(key).push(task);
        console.log(`📦 Task ${task.id} added to upload batch ${key} (${this.batches.get(key).length} tasks)`);
    }

    /**
     * 触发批量上传
     */
    async trigger(key) {
        const tasks = this.batches.get(key);
        if (!tasks || tasks.length === 0) return;
        
        this.batches.delete(key);
        console.log(`🚀 Triggering batch upload for ${key} with ${tasks.length} tasks`);
        
        try {
            await this.processBatchFn(tasks);
        } catch (e) {
            console.error(`Batch upload failed for ${key}:`, e);
            tasks.forEach(t => {
                if (t.onUploadComplete) t.onUploadComplete({ success: false, error: e.message });
            });
        }
    }
}

/**
 * --- 任务管理调度中心 (TaskManager) ---
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
            console.error("TaskManager.batchUpdateStatus failed:", e);
            // 降级到单个更新
            for (const update of updates) {
                try {
                    await TaskRepository.updateStatus(update.id, update.status, update.error);
                } catch (err) {
                    console.error(`Failed to update task ${update.id}:`, err);
                }
            }
        }
    }

    // 分离下载和上传队列
    static downloadQueue = new PQueue({ concurrency: 1 }); // 下载队列：处理MTProto下载，降低并发避免连接压力
    static uploadQueue = new PQueue({ concurrency: 1 });   // 上传队列：处理rclone转存

    // 兼容性：保留原有queue引用
    static get queue() { return this.downloadQueue; }
    static set queue(value) { this.downloadQueue = value; }

    static waitingTasks = [];
    static currentTask = null;
    static waitingUploadTasks = []; // 等待上传的任务队列
    
    // 内存中的任务执行锁，防止同一任务被多次 worker 处理
    static activeWorkers = new Set();

    // 初始化聚合器
    static uploadBatcher = new UploadBatcher(async (tasks) => {
        const result = await CloudTool.uploadBatch(tasks, (tid, progress) => {
            const targetTask = tasks.find(bt => bt.id === tid);
            if (targetTask && targetTask.onUploadProgress) {
                targetTask.onUploadProgress(progress);
            }
        });
        tasks.forEach(bt => {
            if (bt.onUploadComplete) bt.onUploadComplete(result);
        });
    });

    /**
     * 初始化：恢复因重启中断的僵尸任务
     */
    static async init() {
        console.log("🔄 正在检查数据库中异常中断的任务...");
        try {
            // 并行加载初始化数据：僵尸任务 + 预热常用缓存
            const results = await Promise.allSettled([
                TaskRepository.findStalledTasks(120000),
                this._preloadCommonData() // 预加载常用数据
            ]);

            const tasks = results[0].status === 'fulfilled' ? results[0].value : [];
            // 预加载失败不会影响主流程，只记录日志

            if (!tasks || tasks.length === 0) {
                console.log("✅ 没有发现僵尸任务。");
                return;
            }

            console.log(`📥 发现 \${tasks.length} 个僵尸任务，正在按 Chat 分组批量恢复...`);

            const chatGroups = new Map();
            for (const row of tasks) {
                if (!row.chat_id || row.chat_id.includes("Object")) {
                    console.warn(`⚠️ 跳过无效 chat_id 的任务: \${row.id}`);
                    continue;
                }
                if (!chatGroups.has(row.chat_id)) {
                    chatGroups.set(row.chat_id, []);
                }
                chatGroups.get(row.chat_id).push(row);
            }

            // 并行恢复所有chat groups的任务
            const restorePromises = Array.from(chatGroups.entries()).map(([chatId, rows]) =>
                this._restoreBatchTasks(chatId, rows)
            );
            await Promise.allSettled(restorePromises);

            this.updateQueueUI();
        } catch (e) {
            console.error("TaskManager.init critical error:", e);
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
                import("../utils/CacheService.js").then(({ cacheService }) => {
                    // 确保缓存服务已初始化
                    return Promise.resolve(cacheService);
                }),

                // 预加载 KV 服务
                import("../services/kv.js").then(({ kv }) => {
                    // 预热 KV 连接
                    return kv.get("system:health_check", "text").catch(() => "ok");
                })
            );

            // 并行执行所有预加载任务
            const results = await Promise.allSettled(preloadTasks);

            // 统计预加载结果
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            const totalCount = results.length;

            console.log(`📊 预加载常用数据完成: \${successCount}/\${totalCount} 个任务成功`);

            // 如果大部分预加载失败，记录警告
            if (successCount < totalCount * 0.7) {
                console.warn(`⚠️ 预加载成功率较低: \${successCount}/\${totalCount}`);
            }

        } catch (e) {
            console.warn("预加载数据失败:", e.message);
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

            for (const row of rows) {
                const message = messageMap.get(row.source_msg_id);
                if (!message || !message.media) {
                    console.warn(`⚠️ 无法找到原始消息 (ID: \${row.source_msg_id})`);
                    failedUpdates.push({ id: row.id, status: 'failed', error: 'Source msg missing' });
                    continue;
                }

                const task = this._createTaskObject(row.id, row.user_id, row.chat_id, row.msg_id, message);
                validTasks.push(task);

                // 根据任务状态决定恢复到哪个队列
                if (row.status === 'downloaded') {
                    // 恢复到上传队列
                    const localPath = path.join(config.downloadDir, row.file_name);
                    if (fs.existsSync(localPath)) {
                        task.localPath = localPath;
                        tasksToUpload.push(task);
                        console.log(`📤 恢复下载完成的任务 \${row.id} 到上传队列`);
                    } else {
                        // 本地文件不存在，重新下载
                        console.warn(`⚠️ 本地文件不存在，重新下载任务 \${row.id}`);
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

            // 并发发送恢复消息（限制并发避免 API 限制）
            const recoveryPromises = validTasks.map(task =>
                updateStatus(task, "🔄 **系统重启，检测到任务中断，已自动恢复...**")
            );
            await Promise.allSettled(recoveryPromises);

            // 批量入队下载任务
            tasksToEnqueue.forEach(task => this._enqueueTask(task));

            // 批量入队上传任务
            tasksToUpload.forEach(task => this._enqueueUploadTask(task));

        } catch (e) {
            console.error(`批量恢复会话 \${chatId} 的任务失败:`, e);
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
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_\${taskId}`))],
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            3
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

            const task = this._createTaskObject(taskId, userId, chatIdStr, statusMsg.id, mediaMessage);
            this._enqueueTask(task);
            this.updateQueueUI();

        } catch (e) {
            console.error("Task creation failed:", e);
            // 尝试更新状态消息，如果失败则记录但不抛出异常
            try {
                await client.editMessage(target, {
                    message: statusMsg.id,
                    text: STRINGS.task.create_failed
                });
            } catch (editError) {
                console.warn("Failed to update error message:", editError.message);
            }
        }
    }

    /**
     * 批量添加媒体组任务
     */
    static async addBatchTasks(target, messages, userId) {
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        const statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.batch_captured, { count: messages.length }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_batch_\${messages[0].groupedId}`))],
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            3
        );

        const tasksData = [];
        const taskObjects = [];

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

            const task = this._createTaskObject(taskId, userId, chatIdStr, statusMsg.id, msg);
            task.isGroup = true;
            taskObjects.push(task);
        }

        await TaskRepository.createBatch(tasksData);

        for (const task of taskObjects) {
            this._enqueueTask(task);
        }
        this.updateQueueUI();
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
     * [私有] 将任务推入下载队列
     */
    static _enqueueTask(task) {
        this.waitingTasks.push(task);
        this.downloadQueue.add(async () => {
            this.currentTask = task;
            await this.downloadWorker(task);
            this.currentTask = null;
        });
    }

    /**
     * [私有] 将任务推入上传队列
     */
    static _enqueueUploadTask(task) {
        this.waitingUploadTasks.push(task);
        this.uploadQueue.add(async () => {
            this.waitingUploadTasks = this.waitingUploadTasks.filter(t => t.id !== task.id);
            await this.uploadWorker(task);
        });
    }

    /**
     * 批量更新排队中的 UI
     */
    static async updateQueueUI() {
        // 获取快照以避免在循环中由于数组变动导致 index 越界
        const snapshot = [...this.waitingTasks];
        const maxTasks = Math.min(snapshot.length, 5);
        
        for (let i = 0; i < maxTasks; i++) {
            const task = snapshot[i];
            if (!task || task.isGroup) continue;

            const newText = format(STRINGS.task.queued, { rank: i + 1 });

            if (task.lastText !== newText) {
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
     * 下载Worker - 负责MTProto下载阶段
     */
    static async downloadWorker(task) {
        const { message, id } = task;
        if (!message.media) return;

        // 防重入：检查任务是否已经在处理中
        if (this.activeWorkers.has(id)) {
            console.log(`⚠️ Task \${id} is already being processed, skipping download worker.`);
            return;
        }
        this.activeWorkers.add(id);

        this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
        this.updateQueueUI();

        const info = getMediaInfo(message.media);
        if (!info) {
            this.activeWorkers.delete(id);
            return await updateStatus(task, STRINGS.task.parse_failed, true);
        }

        const localPath = path.join(config.downloadDir, info.name);
        task.localPath = localPath;

        let lastUpdate = 0;
        const heartbeat = async (status, downloaded = 0, total = 0) => {
            if (task.isCancelled) throw new Error("CANCELLED");
            await TaskRepository.updateStatus(task.id, status);

            if (task.isGroup) {
                await this._refreshGroupMonitor(task, status, downloaded, total);
            } else {
                const text = (downloaded > 0)
                    ? UIHelper.renderProgress(downloaded, total, STRINGS.task.downloading, info.name)
                    : STRINGS.task.downloading;
                await updateStatus(task, text);
            }
        };

        try {
            await heartbeat('downloading');

            // 秒传检查 - 如果文件已存在且大小匹配，直接标记完成
            // 使用异步文件检查避免阻塞
            const localPath = path.join(config.downloadDir, info.name);
            let localFileExists = false;
            let localFileSize = 0;

            try {
                const stats = await fs.promises.stat(localPath);
                localFileExists = true;
                localFileSize = stats.size;
            } catch (e) {
                // 文件不存在，继续下载
            }

            if (localFileExists && Math.abs(localFileSize - info.size) < 1024) {
                // 本地文件已存在且大小匹配，检查远程是否存在
                const remoteFile = await CloudTool.getRemoteFileInfo(info.name, task.userId);
                if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
                    await TaskRepository.updateStatus(task.id, 'completed');
                    if (task.isGroup) {
                        await this._refreshGroupMonitor(task, 'completed');
                    } else {
                        await updateStatus(task, format(STRINGS.task.success_sec_transfer, { name: escapeHTML(info.name), folder: config.remoteFolder }), true);
                    }
                    this.activeWorkers.delete(id);
                    return;
                }
            }

            // 下载阶段 - MTProto文件下载
            const isLargeFile = info.size > 100 * 1024 * 1024;
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

            await runMtprotoFileTaskWithRetry(() => client.downloadMedia(message, downloadOptions), {}, 5); // 增加重试次数到5次

            // 下载完成，推入上传队列
            await TaskRepository.updateStatus(task.id, 'downloaded');
            if (!task.isGroup) {
                await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(info.name) }));
            }

            // 推入上传队列进行后续处理
            this.activeWorkers.delete(id); // 下载完成，释放锁以便上传 Worker 获取
            this._enqueueUploadTask(task);

        } catch (e) {
            const isCancel = e.message === "CANCELLED";
            await TaskRepository.updateStatus(task.id, isCancel ? 'cancelled' : 'failed', e.message);

            if (task.isGroup) {
                await this._refreshGroupMonitor(task, isCancel ? 'cancelled' : 'failed');
            } else {
                const text = isCancel ? STRINGS.task.cancelled : `\${STRINGS.task.error_prefix}<code>\${escapeHTML(e.message)}</code>`;
                await updateStatus(task, text, true);
            }
            this.activeWorkers.delete(id);
        }
    }

    /**
     * 上传Worker - 负责rclone转存阶段（无需MTProto）
     */
    static async uploadWorker(task) {
        const { id } = task;

        // 防重入：上传 Worker 也增加检查
        if (this.activeWorkers.has(id)) {
            console.log(`⚠️ Task \${id} is already being processed, skipping upload worker.`);
            return;
        }
        this.activeWorkers.add(id);

        const info = getMediaInfo(task.message.media);
        if (!info) {
            this.activeWorkers.delete(id);
            return;
        }

        const localPath = task.localPath;
        if (!fs.existsSync(localPath)) {
            await TaskRepository.updateStatus(task.id, 'failed', 'Local file not found');
            await updateStatus(task, STRINGS.task.failed_validation, true);
            this.activeWorkers.delete(id);
            return;
        }

        let lastUpdate = 0;
        const heartbeat = async (status, downloaded = 0, total = 0, uploadProgress = null) => {
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

        try {
            // 上传阶段 - rclone批量上传
            if (!task.isGroup) await updateStatus(task, STRINGS.task.uploading);
            await heartbeat('uploading');

            const uploadResult = await new Promise(async (resolve) => {
                task.onUploadComplete = (result) => resolve(result);
                task.onUploadProgress = async (progress) => {
                    const now = Date.now();
                    if (now - lastUpdate > 3000) {
                        lastUpdate = now;
                        await heartbeat('uploading', 0, 0, progress);
                    }
                };
                this.uploadBatcher.add(task);
            });

            // 结果处理
            if (uploadResult.success) {
                if (!task.isGroup) await updateStatus(task, STRINGS.task.verifying);
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name, task.userId);
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;

                const finalStatus = isOk ? 'completed' : 'failed';
                await TaskRepository.updateStatus(task.id, finalStatus);

                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, finalStatus);
                } else {
                    const fileLink = `tg://openmessage?chat_id=\${task.chatId}&message_id=\${task.message.id}`;
                    const fileNameHtml = `<a href="\${fileLink}">\${escapeHTML(info.name)}</a>`;
                    const baseText = isOk
                        ? STRINGS.task.success.replace('{{name}}', fileNameHtml).replace('{{folder}}', config.remoteFolder)
                        : STRINGS.task.failed_validation.replace('{{name}}', fileNameHtml);
                    await updateStatus(task, baseText, true);
                }
            } else {
                await TaskRepository.updateStatus(task.id, 'failed', uploadResult.error || "Upload failed");
                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, 'failed');
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
                const text = isCancel ? STRINGS.task.cancelled : `\${STRINGS.task.error_prefix}<code>\${escapeHTML(e.message)}</code>`;
                await updateStatus(task, text, true);
            }
        } finally {
            // 上传完成后异步清理本地文件
            try {
                // 检查 fs.promises 是否可用（兼容性处理）
                if (fs.promises && fs.promises.unlink) {
                    await fs.promises.unlink(localPath);
                } else {
                    // 降级到同步删除（用于测试环境）
                    fs.unlinkSync(localPath);
                }
            } catch (e) {
                // 忽略清理失败的错误，文件可能已被其他进程处理
                console.warn(`Failed to cleanup local file \${localPath}:`, e.message);
            }
            this.activeWorkers.delete(id);
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

        await TaskRepository.markCancelled(taskId);
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
                } catch (error) {
                    console.error('Auto-scaling adjustment error:', error.message);
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
     * [私有] 刷新组任务看板 (智能节流)
     */
    static async _refreshGroupMonitor(task, status, downloaded = 0, total = 0) {
        const msgId = task.msgId;
        const lastUpdate = this.monitorLocks.get(msgId) || 0;
        const now = Date.now();
        const isFinal = status === 'completed' || status === 'failed' || status === 'cancelled';

        // 动态节流：最终状态立即更新，进度状态智能节流
        let throttleMs = 0;
        if (!isFinal) {
            // 非最终状态的智能节流
            if (status === 'downloading' || status === 'uploading') {
                // 下载/上传状态：根据进度调整节流时间
                const progress = total > 0 ? downloaded / total : 0;
                if (progress < 0.1) {
                    throttleMs = 1000; // 初期：1秒
                } else if (progress < 0.5) {
                    throttleMs = 2000; // 中期：2秒
                } else {
                    throttleMs = 3000; // 后期：3秒
                }
            } else {
                // 其他状态：2秒节流
                throttleMs = 2000;
            }
        }

        if (now - lastUpdate < throttleMs) return;
        this.monitorLocks.set(msgId, now);

        const groupTasks = await TaskRepository.findByMsgId(msgId);
        if (!groupTasks.length) return;

        // 【修复】不再批量更新整个组的状态，而是只更新当前任务的状态
        // 逻辑已在 worker 中处理了 TaskRepository.updateStatus，这里仅做 UI 刷新
        
        const { text } = UIHelper.renderBatchMonitor(groupTasks, task, status, downloaded, total);

        let peer = task.chatId;
        if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);
        
        // 使用统一的 safeEdit 以处理 MESSAGE_NOT_MODIFIED 等错误
        await safeEdit(peer, parseInt(task.msgId), text, null, task.userId, "html");
    }
}