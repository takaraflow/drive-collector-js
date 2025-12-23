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
import { runBotTask, runMtprotoTask } from "../utils/limiter.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { TaskRepository } from "../repositories/TaskRepository.js"; // 👈 引入 Repo

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

            const messages = await runMtprotoTask(() => client.getMessages(row.chat_id, { ids: [row.source_msg_id] }));
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
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target).toString();

        // 1. 发送排队 UI
        const statusMsg = await runBotTask(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.captured, { label: customLabel }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_${taskId}`))]
            }),
            userId
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
     * [私有] 标准化构造内存中的任务对象
     */
    static _createTaskObject(id, userId, chatId, msgId, message) {
        return {
            id,
            userId: userId.toString(),
            chatId: chatId.toString(),
            msgId,
            message,
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
     * 任务执行核心 Worker
     * @param {Object} task 
     */
    static async fileWorker(task) {
        const { message, id } = task;
        if (!message.media) return;

        // 从等待队列移除
        this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
        this.updateQueueUI(); 

        const info = getMediaInfo(message.media);
        if (!info) return await updateStatus(task, "❌ 无法解析该媒体文件信息。", true);

        const localPath = path.join(config.downloadDir, info.name);

        // --- 心跳函数 ---
        // 封装心跳逻辑，减少重复代码
        const heartbeat = async (status) => {
            if (task.isCancelled) throw new Error("CANCELLED");
            await TaskRepository.updateStatus(task.id, status);
        };

        try {
            await heartbeat('downloading');

            // 1. 秒传检查
            const remoteFile = await CloudTool.getRemoteFileInfo(info.name, task.userId);
            // 误差 1KB 内视为同一文件
            if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
                await TaskRepository.updateStatus(task.id, 'completed');
                return await updateStatus(task, `✨ **文件已秒传成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\``, true);
            }

            // 2. 下载阶段
            let lastUpdate = 0;
            await runMtprotoTask(() => client.downloadMedia(message, {
                    outputFile: localPath,
                    chunkSize: 1024 * 1024,
                    workers: 1,
                    progressCallback: async (downloaded, total) => {
                        if (task.isCancelled) throw new Error("CANCELLED");
                        const now = Date.now();
                        // 3秒 UI 节流 + 数据库心跳
                        if (now - lastUpdate > 3000 || downloaded === total) {
                            lastUpdate = now;
                            await updateStatus(task, UIHelper.renderProgress(downloaded, total));
                            await heartbeat('downloading');
                        }
                    }
                })
            );

            await updateStatus(task, "📤 **资源拉取完成，正在启动转存...**");
            await heartbeat('uploading');
            
            // 3. 上传阶段
            const uploadResult = await CloudTool.uploadFile(localPath, task, async () => {
                await heartbeat('uploading'); 
            });

            // 4. 结果处理
            if (uploadResult.success) {
                await updateStatus(task, "⚙️ **转存完成，正在确认数据完整性...**");
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name, task.userId);
                // 二次校验
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;
                
                if (isOk) {
                    await TaskRepository.updateStatus(task.id, 'completed');
                } else {
                    await TaskRepository.updateStatus(task.id, 'failed', 'Validation failed');
                }

                await updateStatus(task, isOk ? `✅ **文件转存成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\`` : `⚠️ **校验异常**: \`${info.name}\``, true);
            } else {
                await TaskRepository.updateStatus(task.id, 'failed', uploadResult.error || "Upload failed");
                await updateStatus(task, `❌ **同步终止**\n原因: \`${task.isCancelled ? "用户手动取消" : uploadResult.error}\``, true);
            }
        } catch (e) {
            const isCancel = e.message === "CANCELLED";
            await TaskRepository.updateStatus(task.id, isCancel ? 'cancelled' : 'failed', e.message);
            await updateStatus(task, isCancel ? "🚫 任务已取消。" : `⚠️ 处理异常: ${e.message}`, true);
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
}