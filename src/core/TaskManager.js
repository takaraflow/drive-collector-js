import PQueue from "p-queue";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { config } from "../config/index.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { UIHelper } from "../ui/templates.js";
import { getMediaInfo, updateStatus } from "../utils/common.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, runMtprotoFileTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
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
    static queue = new PQueue({ concurrency: 1 });
    static waitingTasks = [];
    static currentTask = null;
    
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
            const tasks = await TaskRepository.findStalledTasks(120000);
            
            if (!tasks || tasks.length === 0) {
                console.log("✅ 没有发现僵尸任务。");
                return;
            }

            console.log(`📥 发现 ${tasks.length} 个僵尸任务，正在按 Chat 分组批量恢复...`);
            
            const chatGroups = new Map();
            for (const row of tasks) {
                if (!row.chat_id || row.chat_id.includes("Object")) {
                    console.warn(`⚠️ 跳过无效 chat_id 的任务: ${row.id}`);
                    continue;
                }
                if (!chatGroups.has(row.chat_id)) {
                    chatGroups.set(row.chat_id, []);
                }
                chatGroups.get(row.chat_id).push(row);
            }

            for (const [chatId, rows] of chatGroups) {
                await this._restoreBatchTasks(chatId, rows);
            }

            this.updateQueueUI();
        } catch (e) {
            console.error("TaskManager.init critical error:", e);
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

            for (const row of rows) {
                const message = messageMap.get(row.source_msg_id);
                if (!message || !message.media) {
                    console.warn(`⚠️ 无法找到原始消息 (ID: ${row.source_msg_id})`);
                    await TaskRepository.updateStatus(row.id, 'failed', 'Source msg missing');
                    continue;
                }

                const task = this._createTaskObject(row.id, row.user_id, row.chat_id, row.msg_id, message);
                await updateStatus(task, "🔄 **系统重启，检测到任务中断，已自动恢复...**");
                this._enqueueTask(task);
            }
        } catch (e) {
            console.error(`批量恢复会话 ${chatId} 的任务失败:`, e);
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
            await client.editMessage(target, { 
                message: statusMsg.id, 
                text: STRINGS.task.create_failed
            }).catch(() => {});
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
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_batch_${messages[0].groupedId}`))],
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
     * [私有] 将任务推入队列并开始执行
     */
    static _enqueueTask(task) {
        this.waitingTasks.push(task);
        this.queue.add(async () => {
            this.currentTask = task;
            await this.fileWorker(task);
            this.currentTask = null;
        });
    }

    /**
     * 批量更新排队中的 UI
     */
    static async updateQueueUI() {
        for (let i = 0; i < Math.min(this.waitingTasks.length, 5); i++) {
            const task = this.waitingTasks[i];
            if (task.isGroup) continue;
            const newText = format(STRINGS.task.queued, { rank: i + 1 });
            if (task.lastText !== newText) {
                await updateStatus(task, newText);
                task.lastText = newText;
                await new Promise(r => setTimeout(r, 1200));
            }
        }
    }

    /**
     * 任务执行核心 Worker
     */
    static async fileWorker(task) {
        const { message, id } = task;
        if (!message.media) return;

        this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
        this.updateQueueUI(); 

        const info = getMediaInfo(message.media);
        if (!info) return await updateStatus(task, STRINGS.task.parse_failed, true);

        const localPath = path.join(config.downloadDir, info.name);
        task.localPath = localPath;

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
                    text = (downloaded > 0) 
                        ? UIHelper.renderProgress(downloaded, total, status === 'uploading' ? STRINGS.task.uploading : STRINGS.task.downloading, info.name) 
                        : (status === 'uploading' ? STRINGS.task.uploading : STRINGS.task.downloading);
                }
                await updateStatus(task, text);
            }
        };

        try {
            await heartbeat('downloading');

            // 2. 秒传检查
            const remoteFile = await CloudTool.getRemoteFileInfo(info.name, task.userId);
            if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
                await TaskRepository.updateStatus(task.id, 'completed');
                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, 'completed');
                } else {
                    await updateStatus(task, format(STRINGS.task.success_sec_transfer, { name: info.name, folder: config.remoteFolder }), true);
                }
                return;
            }

            // 3. 下载阶段
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

            await runMtprotoFileTaskWithRetry(() => client.downloadMedia(message, downloadOptions));

            // 4. 上传阶段 (使用聚合器)
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

            // 5. 结果处理
            if (uploadResult.success) {
                if (!task.isGroup) await updateStatus(task, STRINGS.task.verifying);
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name, task.userId);
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;
                
                const finalStatus = isOk ? 'completed' : 'failed';
                await TaskRepository.updateStatus(task.id, finalStatus);

                if (task.isGroup) {
                    await this._refreshGroupMonitor(task, finalStatus);
                } else {
                    const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                    const fileNameHtml = `<a href="${fileLink}">${info.name}</a>`;
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
                        reason: task.isCancelled ? "用户手动取消" : uploadResult.error 
                    }), true);
                }
            }
        } catch (e) {
            const isCancel = e.message === "CANCELLED";
            await TaskRepository.updateStatus(task.id, isCancel ? 'cancelled' : 'failed', e.message);
            
            if (task.isGroup) {
                await this._refreshGroupMonitor(task, isCancel ? 'cancelled' : 'failed');
            } else {
                const text = isCancel ? STRINGS.task.cancelled : `${STRINGS.task.error_prefix}${e.message}`;
                await updateStatus(task, text, true);
            }
        } finally {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
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

        const task = this.waitingTasks.find(t => t.id.toString() === taskId) || 
                     (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);
        
        if (task) {
            task.isCancelled = true;
            if (task.proc) task.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
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
     * [私有] 刷新组任务看板
     */
    static async _refreshGroupMonitor(task, status, downloaded = 0, total = 0) {
        const msgId = task.msgId;
        const lastUpdate = this.monitorLocks.get(msgId) || 0;
        const now = Date.now();
        const isFinal = status === 'completed' || status === 'failed';
        
        if (!isFinal && now - lastUpdate < 2500) return;
        this.monitorLocks.set(msgId, now);

        const groupTasks = await TaskRepository.findByMsgId(msgId);
        if (!groupTasks.length) return;

        const { text } = UIHelper.renderBatchMonitor(groupTasks, task, status, downloaded, total);
        
        try {
            let peer = task.chatId;
            if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);
            await client.editMessage(peer, {
               message: parseInt(task.msgId),
               text: text,
               parseMode: "html"
           });
       } catch (e) {
           console.error(`[Monitor Update Error] msgId ${msgId}:`, e.message);
       }
    }
}