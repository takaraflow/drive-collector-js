import PQueue from "p-queue";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { config } from "../config/index.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { d1 } from "../services/d1.js";
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
     * 初始化：系统启动时从数据库恢复未完成的任务
     */
    static async init() {
        console.log("🔄 正在检查数据库中未完成的任务...");
        try {
            // 捞取所有状态为排队中、下载中或上传中的任务 (重启后统统视为需要重新处理)
            const tasks = await d1.fetchAll("SELECT * FROM tasks WHERE status IN ('queued', 'downloading', 'uploading') ORDER BY created_at ASC");
            
            if (!tasks || tasks.length === 0) {
                console.log("✅ 没有发现中断的任务。");
                return;
            }

            console.log(`📥 发现 ${tasks.length} 个中断任务，正在恢复队列...`);
            
            for (const row of tasks) {
                try {
                    // 核心逻辑：必须通过 Telegram API 重新获取原始的消息对象
                    // 因为我们无法将复杂的 Message 对象存入 SQLite，只能存 ID
                    const messages = await client.getMessages(row.chat_id, { ids: [row.source_msg_id] });
                    const message = messages[0];

                    if (!message || !message.media) {
                        console.warn(`⚠️ 无法找到原始消息 (ID: ${row.source_msg_id})，标记为失败。`);
                        await d1.run("UPDATE tasks SET status = 'failed', error_msg = 'Source message not found on restore' WHERE id = ?", [row.id]);
                        continue;
                    }

                    // 重建任务对象
                    const task = { 
                        id: row.id, 
                        chatId: row.chat_id, 
                        msgId: row.msg_id, // 复用之前的进度条消息
                        message: message,  // 注入刚获取的鲜活 Message 对象
                        lastText: "",
                        isCancelled: false 
                    };

                    // 更新一下 UI，告诉用户我们复活了
                    await updateStatus(task, "🔄 **系统重启，任务已自动恢复...**\n正在重新排队等待处理...");

                    // 推入内存队列
                    this.waitingTasks.push(task);
                    this.queue.add(async () => {
                        this.currentTask = task;
                        await this.fileWorker(task);
                        this.currentTask = null;
                    });
                } catch (e) {
                    console.error(`恢复任务 ${row.id} 失败:`, e);
                }
            }
            // 刷新排队 UI
            this.updateQueueUI();
        } catch (e) {
            console.error("TaskManager Init 严重错误:", e);
        }
    }

    /**
     * 添加新任务到队列
     */
    static async addTask(target, mediaMessage, customLabel = "") {
        const taskId = Date.now().toString(); // 统一转为字符串存储
        const statusMsg = await client.sendMessage(target, {
            message: `🚀 **已捕获${customLabel}任务**\n正在排队处理...`,
            buttons: [Button.inline("🚫 取消排队", Buffer.from(`cancel_${taskId}`))]
        });

        const info = getMediaInfo(mediaMessage);

        // 1. 持久化：写入数据库
        try {
            await d1.run(`
                INSERT INTO tasks (id, chat_id, msg_id, source_msg_id, file_name, file_size, status, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
            `, [taskId, target.toString(), statusMsg.id, mediaMessage.id, info?.name || 'unknown', info?.size || 0, Date.now()]);
        } catch (e) {
            console.error("DB Write Error:", e);
            // 即使数据库写入失败，内存队列也要继续跑，不能阻塞用户
        }

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
     * 批量更新排队中的 UI
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
     * 任务执行核心 Worker
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
            // DB 状态更新：开始下载
            await d1.run("UPDATE tasks SET status = 'downloading' WHERE id = ?", [task.id]).catch(console.error);

            const remoteFile = await CloudTool.getRemoteFileInfo(info.name);
            if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
                // 秒传也视为完成
                await d1.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [task.id]).catch(console.error);
                return await updateStatus(task, `✨ **文件已秒传成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\``, true);
            }

            let lastUpdate = 0;
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

            await updateStatus(task, "📤 **资源拉取完成，正在启动转存...**");
            
            // DB 状态更新：开始上传
            await d1.run("UPDATE tasks SET status = 'uploading' WHERE id = ?", [task.id]).catch(console.error);
            
            const uploadResult = await CloudTool.uploadFile(localPath, task);

            if (uploadResult.success) {
                await updateStatus(task, "⚙️ **转存完成，正在确认数据完整性...**");
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name);
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;
                
                // DB 状态更新：完成 (或失败)
                if (isOk) {
                    await d1.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [task.id]).catch(console.error);
                } else {
                    await d1.run("UPDATE tasks SET status = 'failed', error_msg = 'Validation failed' WHERE id = ?", [task.id]).catch(console.error);
                }

                await updateStatus(task, isOk ? `✅ **文件转存成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\`` : `⚠️ **校验异常**: \`${info.name}\``, true);
            } else {
                // DB 状态更新：上传失败
                await d1.run("UPDATE tasks SET status = 'failed', error_msg = ? WHERE id = ?", [uploadResult.error || "Upload failed", task.id]).catch(console.error);
                await updateStatus(task, `❌ **同步终止**\n原因: \`${task.isCancelled ? "用户手动取消" : uploadResult.error}\``, true);
            }
        } catch (e) {
            const isCancel = e.message === "CANCELLED";
            // DB 状态更新：异常或取消
            await d1.run("UPDATE tasks SET status = ?, error_msg = ? WHERE id = ?", [isCancel ? 'cancelled' : 'failed', e.message, task.id]).catch(console.error);
            await updateStatus(task, isCancel ? "🚫 任务已取消。" : `⚠️ 处理异常: ${e.message}`, true);
        } finally {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        }
    }

    /**
     * 取消指定任务
     */
    static cancelTask(taskId) {
        const task = this.waitingTasks.find(t => t.id.toString() === taskId) || 
                     (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);
        if (task) {
            task.isCancelled = true;
            if (task.proc) task.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
            
            // DB 状态更新：取消
            d1.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [taskId]).catch(console.error);
            return true;
        }
        return false;
    }
}