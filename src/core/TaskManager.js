import PQueue from "p-queue";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { config } from "../config/index.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { UIHelper } from "../ui/templates.js";
import { getMediaInfo, updateStatus } from "../utils/common.js";

/**
 * --- 任务管理调度中心 (TaskManager) ---
 */
export class TaskManager {
    static queue = new PQueue({ concurrency: 1 });
    static waitingTasks = [];
    static currentTask = null;

    /**
     * 添加新任务到队列
     */
    static async addTask(target, mediaMessage, customLabel = "") {
        const taskId = Date.now() + Math.random();
        const statusMsg = await client.sendMessage(target, {
            message: `🚀 **已捕获${customLabel}任务**\n正在排队处理...`,
            buttons: [Button.inline("🚫 取消排队", Buffer.from(`cancel_${taskId}`))]
        });

        const task = { 
            id: taskId, 
            chatId: target, 
            msgId: statusMsg.id, 
            message: mediaMessage, 
            lastText: "",
            isCancelled: false 
        };

        this.waitingTasks.push(task);
        this.queue.add(async () => {
            this.currentTask = task;
            await this.fileWorker(task);
            this.currentTask = null;
        });

        this.updateQueueUI();
    }

    /**
     * 批量更新排队中的 UI (顺位提示)
     */
    static async updateQueueUI() {
        for (let i = 0; i < Math.min(this.waitingTasks.length, 5); i++) {
            const task = this.waitingTasks[i];
            const newText = `🕒 **任务排队中...**\n\n当前顺位: \`第 ${i + 1} 位\``;
            if (task.lastText !== newText) {
                await updateStatus(task, newText);
                task.lastText = newText;
                await new Promise(r => setTimeout(r, 1200));
            }
        }
    }

    /**
     * 任务执行核心 Worker (处理下载与上传生命周期)
     */
    static async fileWorker(task) {
        const { message, id } = task;
        if (!message.media) return;

        this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
        this.updateQueueUI(); 

        const info = getMediaInfo(message.media);
        if (!info) return await updateStatus(task, "❌ 无法解析该媒体文件信息。", true);

        const localPath = path.join(config.downloadDir, info.name);

        try {
            // 转存前先检查云端是否已存在
            const remoteFile = await CloudTool.getRemoteFileInfo(info.name);
            if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
                return await updateStatus(task, `✨ **文件已秒传成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\``, true);
            }

            let lastUpdate = 0;
            // 阶段 1: 从 Telegram 下载到本地服务器
            await client.downloadMedia(message, {
                outputFile: localPath,
                progressCallback: async (downloaded, total) => {
                    if (task.isCancelled) throw new Error("CANCELLED");
                    const now = Date.now();
                    if (now - lastUpdate > 3000 || downloaded === total) {
                        lastUpdate = now;
                        await updateStatus(task, UIHelper.renderProgress(downloaded, total));
                    }
                }
            });

            // 修复进度条显示：在此处开始上传，uploadFile 内部会负责 updateStatus
            await updateStatus(task, "📤 **资源拉取完成，正在启动转存...**");
            // 阶段 2: 从本地服务器上传到网盘
            const uploadResult = await CloudTool.uploadFile(localPath, task);

            if (uploadResult.success) {
                await updateStatus(task, "⚙️ **转存完成，正在确认数据完整性...**");
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name);
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;
                await updateStatus(task, isOk ? `✅ **文件转存成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\`` : `⚠️ **校验异常**: \`${info.name}\``, true);
            } else {
                await updateStatus(task, `❌ **同步终止**\n原因: \`${task.isCancelled ? "用户手动取消" : uploadResult.error}\``, true);
            }
        } catch (e) {
            await updateStatus(task, e.message === "CANCELLED" ? "🚫 任务已取消。" : `⚠️ 处理异常: ${e.message}`, true);
        } finally {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        }
    }

    /**
     * 取消指定任务 (无论是排队中还是执行中)
     */
    static cancelTask(taskId) {
        const task = this.waitingTasks.find(t => t.id.toString() === taskId) || 
                     (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);
        if (task) {
            task.isCancelled = true;
            if (task.proc) task.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
            return true;
        }
        return false;
    }
}