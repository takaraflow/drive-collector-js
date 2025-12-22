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
     * 初始化：只恢复那些 "心跳停止" 的僵尸任务
     */
    static async init() {
        console.log("🔄 正在检查数据库中异常中断的任务...");
        try {
            // 定义超时阈值：2分钟
            const TIMEOUT_MS = 2 * 60 * 1000; 
            const deadLine = Date.now() - TIMEOUT_MS;

            // SQL 关键修改：增加 AND updated_at < ?
            const tasks = await d1.fetchAll(
                `SELECT * FROM tasks 
                WHERE status IN ('queued', 'downloading', 'uploading') 
                AND (updated_at IS NULL OR updated_at < ?) 
                ORDER BY created_at ASC`, 
                [deadLine]
            );
            
            if (!tasks || tasks.length === 0) {
                console.log("✅ 没有发现僵尸任务 (所有进行中的任务都在正常心跳或刚刚启动)。");
                return;
            }

            console.log(`📥 发现 ${tasks.length} 个僵尸任务 (超时未响应)，正在恢复...`);
            
            for (const row of tasks) {
                try {
                    const messages = await client.getMessages(row.chat_id, { ids: [row.source_msg_id] });
                    const message = messages[0];

                    if (!message || !message.media) {
                        console.warn(`⚠️ 无法找到原始消息 (ID: ${row.source_msg_id})，标记为失败。`);
                        await d1.run("UPDATE tasks SET status = 'failed', error_msg = 'Source msg missing' WHERE id = ?", [row.id]);
                        continue;
                    }

                    const task = { 
                        id: row.id, 
                        userId: row.user_id, 
                        chatId: row.chat_id, 
                        msgId: row.msg_id, 
                        message: message, 
                        lastText: "",
                        isCancelled: false 
                    };

                    await updateStatus(task, "🔄 **系统重启，检测到任务中断，已自动恢复...**");
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
            this.updateQueueUI();
        } catch (e) {
            console.error("TaskManager Init 错误:", e);
        }
    }

    /**
     * 添加新任务到队列
     */
    static async addTask(target, mediaMessage, userId, customLabel = "") {
        const taskId = Date.now().toString(); // 统一转为字符串存储
        const statusMsg = await client.sendMessage(target, {
            message: `🚀 **已捕获${customLabel}任务**\n正在排队处理...`,
            buttons: [Button.inline("🚫 取消排队", Buffer.from(`cancel_${taskId}`))]
        });

        const info = getMediaInfo(mediaMessage);

        // 1. 持久化：写入数据库
        try {
            await d1.run(`
                INSERT INTO tasks (id, user_id, chat_id, msg_id, source_msg_id, file_name, file_size, status, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
            `, [
                taskId, 
                userId.toString(), 
                target.toString(), 
                statusMsg.id, 
                mediaMessage.id, 
                info?.name || 'unknown', 
                info?.size || 0, 
                Date.now(), 
                Date.now()
            ]);
        } catch (e) {
            console.error("DB Write Error:", e);
        }

        const task = { 
            id: taskId, 
            userId: userId.toString(), 
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
     * 任务执行核心 Worker (带心跳上报)
     */
    static async fileWorker(task) {
        const { message, id } = task;
        if (!message.media) return;

        this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
        this.updateQueueUI(); 

        const info = getMediaInfo(message.media);
        if (!info) return await updateStatus(task, "❌ 无法解析该媒体文件信息。", true);

        const localPath = path.join(config.downloadDir, info.name);

        // --- 定义心跳函数 ---
        const touchTask = async (status) => {
            // 更新状态的同时，更新 updated_at 为当前时间
            await d1.run(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", 
                [status, Date.now(), task.id]
            ).catch(() => {}); // 忽略轻微的网络报错，不要中断主流程
        };

        try {
            // 1. 开始下载前，先发送一次心跳
            await touchTask('downloading');

            // 🛠️ 注意：getRemoteFileInfo 将来也需要 userId 支持多用户，目前先不动
            const remoteFile = await CloudTool.getRemoteFileInfo(info.name);
            if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
                await d1.run("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?", [Date.now(), task.id]).catch(console.error);
                return await updateStatus(task, `✨ **文件已秒传成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\``, true);
            }

            let lastUpdate = 0;
            // 2. 下载阶段
            await client.downloadMedia(message, {
                outputFile: localPath,
                chunkSize: 1024 * 1024, // 设置为 1MB
                workers: 1,            // 保持 1
                progressCallback: async (downloaded, total) => {
                    if (task.isCancelled) throw new Error("CANCELLED");
                    const now = Date.now();
                    // 每3秒更新一次UI，顺便更新一次数据库心跳
                    if (now - lastUpdate > 3000 || downloaded === total) {
                        lastUpdate = now;
                        await updateStatus(task, UIHelper.renderProgress(downloaded, total));
                        await touchTask('downloading'); // <--- 发送心跳
                    }
                }
            });

            await updateStatus(task, "📤 **资源拉取完成，正在启动转存...**");
            
            // 3. 上传阶段前，先更新状态
            await touchTask('uploading');
            
            // 4. 上传阶段 (传入心跳回调)
            // 🛠️ task 对象里现在包含了 userId，CloudTool 内部可以用 task.userId 来区分配置
            const uploadResult = await CloudTool.uploadFile(localPath, task, async () => {
                // 这个回调会被 rclone.js 定期调用
                await touchTask('uploading'); 
            });

            if (uploadResult.success) {
                await updateStatus(task, "⚙️ **转存完成，正在确认数据完整性...**");
                const finalRemote = await CloudTool.getRemoteFileInfo(info.name);
                const isOk = finalRemote && Math.abs(finalRemote.Size - fs.statSync(localPath).size) < 1024;
                
                if (isOk) {
                    await d1.run("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?", [Date.now(), task.id]).catch(console.error);
                } else {
                    await d1.run("UPDATE tasks SET status = 'failed', error_msg = 'Validation failed', updated_at = ? WHERE id = ?", [Date.now(), task.id]).catch(console.error);
                }

                await updateStatus(task, isOk ? `✅ **文件转存成功**\n\n📄 名称: \`${info.name}\`\n📂 目录: \`${config.remoteFolder}\`` : `⚠️ **校验异常**: \`${info.name}\``, true);
            } else {
                await d1.run("UPDATE tasks SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?", [uploadResult.error || "Upload failed", Date.now(), task.id]).catch(console.error);
                await updateStatus(task, `❌ **同步终止**\n原因: \`${task.isCancelled ? "用户手动取消" : uploadResult.error}\``, true);
            }
        } catch (e) {
            const isCancel = e.message === "CANCELLED";
            await d1.run("UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?", [isCancel ? 'cancelled' : 'failed', e.message, Date.now(), task.id]).catch(console.error);
            await updateStatus(task, isCancel ? "🚫 任务已取消。" : `⚠️ 处理异常: ${e.message}`, true);
        } finally {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        }
    }

    /**
     * 取消指定任务 (异步 + 权限校验)
     */
    static async cancelTask(taskId, userId) {
        // 1. 数据库层面的所有权校验 (防止A取消B的任务)
        const dbTask = await d1.fetchOne("SELECT user_id, status FROM tasks WHERE id = ?", [taskId]);
        
        // 如果任务不存在，或者存在但 user_id 不匹配
        if (!dbTask || dbTask.user_id !== userId.toString()) {
            console.warn(`User ${userId} tried to cancel task ${taskId} (owned by ${dbTask ? dbTask.user_id : 'unknown'})`);
            return false;
        }

        // 2. 内存层面的操作 (杀进程/移除队列)
        const task = this.waitingTasks.find(t => t.id.toString() === taskId) || 
                     (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);
        
        if (task) {
            task.isCancelled = true;
            if (task.proc) task.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
        }

        // 3. DB 状态更新：取消
        // 即使内存里找不到(可能重启过)，也要在数据库里标记为 cancelled
        await d1.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [taskId]).catch(console.error);
        
        return true;
    }
}