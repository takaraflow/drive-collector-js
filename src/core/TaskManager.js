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
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, runMtprotoFileTaskWithRetry } from "../utils/limiter.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { STRINGS, format } from "../locales/zh-CN.js";

/**
 * --- 任务管理调度中心 (TaskManager) ---
 * 负责队列管理、任务恢复、以及具体的下载/上传流程编排
 */
export class TaskManager {
    static queue = new PQueue({ concurrency: 1 });
    static waitingTasks = [];
    static currentTask = null;

    /**
     * 初始化：恢复因重启中断的僵尸任务
     * @returns {Promise<void>}
     */
    static async init() {
        console.log("🔄 正在检查数据库中异常中断的任务...");
        try {
            // 定义超时阈值：2分钟 (120000ms)
            const tasks = await TaskRepository.findStalledTasks(120000);
            
            if (!tasks || tasks.length === 0) {
                console.log("✅ 没有发现僵尸任务。");
                return;
            }

            console.log(`📥 发现 ${tasks.length} 个僵尸任务，正在恢复...`);
            
            for (const row of tasks) {
                await this._restoreTask(row);
            }
            this.updateQueueUI();
        } catch (e) {
            console.error("TaskManager.init critical error:", e);
        }
    }

    /**
     * [私有] 恢复单个任务的逻辑
     * @param {Object} row 数据库行对象
     */
    static async _restoreTask(row) {
        try {
            // 防御性校验：确保 chat_id 有效
            if (!row.chat_id || row.chat_id.includes("Object")) {
                console.warn(`⚠️ 跳过无效 chat_id 的任务: ${row.id}`);
                return;
            }

            const messages = await runMtprotoTaskWithRetry(() => client.getMessages(row.chat_id, { ids: [row.source_msg_id] }));
            const message = messages[0];

            if (!message || !message.media) {
                console.warn(`⚠️ 无法找到原始消息 (ID: ${row.source_msg_id})`);
                await TaskRepository.updateStatus(row.id, 'failed', 'Source msg missing');
                return;
            }

            const task = this._createTaskObject(row.id, row.user_id, row.chat_id, row.msg_id, message);
            
            await updateStatus(task, "🔄 **系统重启，检测到任务中断，已自动恢复...**");
            this._enqueueTask(task);

        } catch (e) {
            console.error(`恢复任务 ${row.id} 失败:`, e);
        }
    }

    /**
     * 添加新任务到队列
     * @param {string|Object} target - 目标聊天对象
     * @param {Object} mediaMessage - 包含媒体的 Telegram 消息对象
     * @param {string} userId - 用户ID
     * @param {string} customLabel - 自定义标签（用于UI显示）
     */
    static async addTask(target, mediaMessage, userId, customLabel = "") {
        const taskId = randomUUID();
        // 确保 ID 统一转换为字符串
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        // 1. 发送排队 UI
        const statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.captured, { label: customLabel }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_${taskId}`))]
            }),
            userId,
            {},
            false,
            3
        );

        const info = getMediaInfo(mediaMessage);

        try {
            // 2. 持久化到 DB (使用 Repository)
            await TaskRepository.create({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceMsgId: mediaMessage.id,
                fileName: info?.name,
                fileSize: info?.size
            });

            // 3. 加入内存队列
            const task = this._createTaskObject(taskId, userId, chatIdStr, statusMsg.id, mediaMessage);
            this._enqueueTask(task);
            this.updateQueueUI();

        } catch (e) {
            console.error("Task creation failed:", e);
            // 💥 如果失败，告诉用户
            await client.editMessage(target, { 
                message: statusMsg.id, 
                text: STRINGS.task.create_failed
            }).catch(() => {});
        }
        
    }

    /**
     * 批量添加媒体组任务
     * @param {string|Object} target 
     * @param {Array} messages 
     * @param {string} userId 
     */
    static async addBatchTasks(target, messages, userId) {
        // 确保 ID 统一转换为字符串
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        // 1. 发送该组唯一的共享看板消息
        const statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.batch_captured, { count: messages.length }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_batch_${messages[0].groupedId}`))],
                parseMode: "markdown"
            }),
            userId,
            {},
            false,
            3
        );

        // 2. 循环创建任务，它们将共享同一个 msgId (看板 ID)
        for (const msg of messages) {
            const taskId = randomUUID();
            const info = getMediaInfo(msg);

            await TaskRepository.create({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id, // 👈 关键：共享同一个消息 ID
                sourceMsgId: msg.id,
                fileName: info?.name,
                fileSize: info?.size
            });

            const task = this._createTaskObject(taskId, userId, chatIdStr, statusMsg.id, msg);
            task.isGroup = true; // 标记这是组任务
            
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
            if (task.isGroup) continue; // 组任务的排队状态在看板中显示，无需单独更新
            const newText = format(STRINGS.task.queued, { rank: i + 1 });
            if (task.lastText !== newText) {
                await updateStatus(task, newText);
                task.lastText = newText;
                // 简单的 UI 节流
                await new Promise(r => setTimeout(r, 1200));
            }
        }
    }

    /**
     * 任务执行核心 Worker (支持媒体组看板)
     * @param {Object} task 
     */
    static async fileWorker(task) {
        const { message, id } = task;
        if (!message.media) return;

        // 1. 队列管理：从等待列表移除
        this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
        this.updateQueueUI(); 

        const info = getMediaInfo(message.media);
        if (!info) return await updateStatus(task, STRINGS.task.parse_failed, true);

        const localPath = path.join(config.downloadDir, info.name);

        /**
         * 🚀 核心改进：统一的心跳函数
         * 会根据 task.isGroup 自动选择是更新“单条消息”还是“组看板”
         */
        const heartbeat = async (status, downloaded = 0, total = 0) => {
            if (task.isCancelled) throw new Error("CANCELLED");
            await TaskRepository.updateStatus(task.id, status);
            
            if (task.isGroup) {
                // 如果是组任务，刷新整个看板
                await this._refreshGroupMonitor(task, status, downloaded, total);
            } else {
                // 如果是普通文件，按原样渲染进度条
                const text = (downloaded > 0) 
                    ? UIHelper.renderProgress(downloaded, total) 
                    : (status === 'uploading' ? STRINGS.task.uploading : STRINGS.task.downloading);
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
            let lastUpdate = 0;
            await runMtprotoFileTaskWithRetry(() => client.downloadMedia(message, {
                    outputFile: localPath,
                    chunkSize: 1024 * 1024,
                    workers: 1,
                    progressCallback: async (downloaded, total) => {
                        const now = Date.now();
                        // 3秒 UI 节流
                        if (now - lastUpdate > 3000 || downloaded === total) {
                            lastUpdate = now;
                            // 调用统一心跳
                            await heartbeat('downloading', downloaded, total);
                        }
                    }
                })
            );

            if (!task.isGroup) await updateStatus(task, STRINGS.task.uploading);
            await heartbeat('uploading');
            
            // 4. 上传阶段
            const uploadResult = await CloudTool.uploadFile(localPath, task, async () => {
                // 上传中的心跳 (没有字节级进度，仅报 status)
                await heartbeat('uploading'); 
            });

            // 5. 结果处理
            if (uploadResult.success) {
                if (!task.isGroup) await updateStatus(task, STRINGS.task.verifying);
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name, task.userId);
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;
                
                const finalStatus = isOk ? 'completed' : 'failed';
                await TaskRepository.updateStatus(task.id, finalStatus);

                if (task.isGroup) {
                    // 组任务：更新看板为最终态
                    await this._refreshGroupMonitor(task, finalStatus);
                } else {
                    // 普通任务：发成功/失败消息
                    const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                    const fileNameHtml = `<a href="${fileLink}">${info.name}</a>`;
                    const baseText = isOk 
                        ? STRINGS.task.success.replace('{{name}}', fileNameHtml).replace('{{folder}}', config.remoteFolder)
                        : STRINGS.task.failed_validation.replace('{{name}}', fileNameHtml);
                    const text = baseText;
                    await updateStatus(task, text, true);
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
     * @param {string} taskId 
     * @param {string} userId - 请求发起人的ID
     * @returns {Promise<boolean>}
     */
    static async cancelTask(taskId, userId) {
        // 1. 权限校验
        const dbTask = await TaskRepository.findById(taskId);
        if (!dbTask) return false;

        const isOwner = dbTask.user_id === userId.toString();
        const canCancelAny = await AuthGuard.can(userId, "task:cancel:any");
        
        if (!isOwner && !canCancelAny) {
            console.warn(`User ${userId} tried to cancel task ${taskId} (owned by ${dbTask.user_id})`);
            return false;
        }

        // 2. 内存操作 (杀进程)
        const task = this.waitingTasks.find(t => t.id.toString() === taskId) || 
                     (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);
        
        if (task) {
            task.isCancelled = true;
            if (task.proc) task.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
        }

        // 3. DB 状态更新
        await TaskRepository.markCancelled(taskId);
        return true;
    }

    // 🆕 UI 节流锁：防止看板更新太快导致 Telegram API 限流
    static monitorLocks = new Map();

    /**
     * [私有] 刷新组任务看板
     */
    static async _refreshGroupMonitor(task, status, downloaded = 0, total = 0) {
        const msgId = task.msgId;
        
        // UI 节流：每 2.5 秒才允许编辑一次看板
        const lastUpdate = this.monitorLocks.get(msgId) || 0;
        const now = Date.now();
        const isFinal = status === 'completed' || status === 'failed';
        
        if (!isFinal && now - lastUpdate < 2500) return;
        this.monitorLocks.set(msgId, now);

        // 1. 拉取该看板下的所有任务状态
        const groupTasks = await TaskRepository.findByMsgId(msgId);
        if (!groupTasks.length) return;

        // 2. 调用 UI 模板生成看板文本
        const { text } = UIHelper.renderBatchMonitor(groupTasks, task, status, downloaded, total);
        
        // 3. 执行安全编辑
        try {
            // 修正编辑逻辑：确保 chatId 是 BigInt 或正确格式
            // 如果 task.chatId 是字符串，尝试转回 BigInt
            let peer = task.chatId;
            if (typeof peer === 'string' && /^-?\d+$/.test(peer)) {
                peer = BigInt(peer);
            }
            await client.editMessage(peer, {
               message: parseInt(task.msgId),
               text: text,
               parseMode: "html"
           });
       } catch (e) {
           // 🚨 至少在测试阶段，打印出这个错误，看看是不是 API 限流了
           console.error(`[Monitor Update Error] msgId ${msgId}:`, e.message);
       }
    }
}