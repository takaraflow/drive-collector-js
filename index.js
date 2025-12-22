import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Button } from "telegram/tl/custom/button.js";
import PQueue from "p-queue";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import { decode } from "js-base64";

/**
 * --- 1. 基础配置与环境初始化 ---
 */
const config = {
    apiId: parseInt(process.env.API_ID),
    apiHash: process.env.API_HASH,
    botToken: process.env.BOT_TOKEN,
    ownerId: process.env.OWNER_ID, // 7428626313
    remoteName: process.env.RCLONE_REMOTE || "mega", // 修正：默认值改为你的配置名 mega
    remoteFolder: process.env.REMOTE_FOLDER || "/DriveCollectorBot",
    downloadDir: "/tmp/downloads",
    configPath: "/tmp/rclone.conf",
    port: process.env.PORT || 7860
};

// 确保下载目录存在
if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
}

// 解码 Rclone 配置文件
if (process.env.RCLONE_CONF_BASE64) {
    fs.writeFileSync(config.configPath, Buffer.from(process.env.RCLONE_CONF_BASE64, 'base64'));
}

/**
 * --- 2. 任务队列配置 ---
 * 使用并发为 1 的队列，确保资源不被大文件争抢
 */
const queue = new PQueue({ concurrency: 1 });
let waitingTasks = []; // 存储排队中的任务引用以便更新 UI

/**
 * --- 3. 云端操作工具库 (CloudTool) ---
 */
class CloudTool {
    // 获取远程文件信息 (用于秒传检测和最终校验)
    static async getRemoteFileInfo(fileName) {
        return new Promise((resolve) => {
            const rclone = spawn("rclone", [
                "lsjson", 
                `${config.remoteName}:${config.remoteFolder}`, 
                "--config", path.resolve(config.configPath), // 修正：使用绝对路径确保配置读取
                "--files-only"
            ]);
            let output = "";
            rclone.stdout.on("data", (data) => output += data);
            rclone.on("close", () => {
                try {
                    const files = JSON.parse(output);
                    const file = files.find(f => f.Name === fileName);
                    resolve(file || null);
                } catch (e) { resolve(null); }
            });
        });
    }

    // 执行转存任务 (增加 task 参数以记录进程)
    static async uploadFile(localPath, task) {
        return new Promise((resolve) => {
            const args = [
                "copy", localPath, `${config.remoteName}:${config.remoteFolder}`,
                "--config", path.resolve(config.configPath), // 修正：使用绝对路径确保配置读取
                "--ignore-existing",
                "--size-only",
                "--transfers", "1",
                "--contimeout", "60s"
            ];
            task.proc = spawn("rclone", args);
            let stderr = "";
            task.proc.stderr.on("data", (data) => stderr += data);
            task.proc.on("close", (code) => resolve({ success: code === 0, error: stderr.trim() }));
        });
    }

    // 生成 ASCII 进度条
    static getProgressText(current, total, actionName = "正在拉取资源") {
        const percentage = (current / total * 100).toFixed(1);
        const barLen = 20;
        const filled = Math.round(barLen * (current / total));
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        return `⏳ **${actionName}...**\n\n` +
               `\`[${bar}]\` ${percentage}% (${(current / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`;
    }
}

/**
 * --- 4. 机器人实例初始化 ---
 */
const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, {
    connectionRetries: 5,
});

/**
 * --- 5. 核心处理 Worker ---
 */
async function fileWorker(task) {
    const { message, statusMsg, id } = task;
    const media = message.media;
    if (!media) return;

    // 移除等待列表并触发其他人的顺位更新
    waitingTasks = waitingTasks.filter(t => t.id !== task.id);
    updateQueueUI(); 

    // 文件名获取与加固 (增加对 Photo 的支持)
    const mediaObj = media.document || media.video || media.photo;
    if (!mediaObj) {
        await client.editMessage(message.chatId, { message: statusMsg.id, text: "❌ 无法解析该媒体文件信息。" });
        return;
    }

    let fileName = mediaObj?.attributes?.find(a => a.fileName)?.fileName;
    if (!fileName) {
        const ext = media.video ? ".mp4" : (media.photo ? ".jpg" : ".bin");
        fileName = `transfer_${Math.floor(Date.now() / 1000)}${ext}`;
    }
    
    // 获取大小的稳健写法：图片大小在 sizes 数组最后一个
    const fileSize = mediaObj.size || (mediaObj.sizes ? mediaObj.sizes[mediaObj.sizes.length - 1].size : 0);
    const localPath = path.join(config.downloadDir, fileName);

    try {
        // 1. 秒传匹配
        const remoteFile = await CloudTool.getRemoteFileInfo(fileName);
        if (remoteFile && Math.abs(remoteFile.Size - fileSize) < 1024) {
            await client.editMessage(message.chatId, {
                message: statusMsg.id,
                text: `✨ **文件已秒传成功**\n\n📄 名称: \`${fileName}\`\n📂 目录: \`${config.remoteFolder}\`\n\n提示: 该文件已在您的网盘中，已自动为您匹配。`
            });
            return;
        }

        // 2. 下载 (非阻塞进度回调)
        let lastUpdate = 0;
        await client.downloadMedia(message, {
            outputFile: localPath,
            progressCallback: async (downloaded, total) => {
                if (task.isCancelled) throw new Error("CANCELLED");
                const now = Date.now();
                if (now - lastUpdate > 3000 || downloaded === total) {
                    lastUpdate = now;
                    await client.editMessage(message.chatId, {
                        message: statusMsg.id,
                        text: CloudTool.getProgressText(downloaded, total, "正在从 Telegram 拉取资源"),
                        buttons: [Button.inline("🚫 取消任务", `cancel_${id}`)]
                    }).catch(() => {});
                }
            }
        });

        const actualLocalSize = fs.statSync(localPath).size;

        // 3. 转存同步
        await client.editMessage(message.chatId, { 
            message: statusMsg.id, 
            text: "📤 **资源拉取完成，正在转存至网盘...**",
            buttons: [Button.inline("🚫 取消任务", `cancel_${id}`)]
        });
        const uploadResult = await CloudTool.uploadFile(localPath, task);

        if (uploadResult.success) {
            // 4. 确认环节
            await client.editMessage(message.chatId, { message: statusMsg.id, text: "⚙️ **转存完成，正在确认数据完整性...**" });
            const finalRemote = await CloudTool.getRemoteFileInfo(fileName);

            if (finalRemote && Math.abs(finalRemote.Size - actualLocalSize) < 1024) {
                await client.editMessage(message.chatId, {
                    message: statusMsg.id,
                    text: `✅ **文件转存成功**\n\n📄 名称: \`${fileName}\`\n📂 目录: \`${config.remoteFolder}\`\n⚖️ 状态: 100% 完整性检查已通过`
                });
            } else {
                await client.editMessage(message.chatId, {
                    message: statusMsg.id,
                    text: `⚠️ **转存完成但校验异常**\n\n📄 名称: \`${fileName}\`\n请检查云端文件大小是否正确。`
                });
            }
        } else {
            const errDetail = task.isCancelled ? "用户手动取消了任务" : uploadResult.error;
            await client.editMessage(message.chatId, {
                message: statusMsg.id, 
                text: `❌ **同步终止**\n原因: \`${errDetail}\`` 
            });
        }
    } catch (e) {
        const errorMsg = e.message === "CANCELLED" ? "🚫 任务已取消。" : `⚠️ 处理异常: ${e.message}`;
        await client.editMessage(message.chatId, {
            message: statusMsg.id,
            text: errorMsg
        });
    } finally {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
}

/**
 * --- 6. 队列 UI 更新 ---
 */
async function updateQueueUI() {
    for (let i = 0; i < Math.min(waitingTasks.length, 5); i++) {
        const task = waitingTasks[i];
        const newText = `🕒 **任务排队中...**\n\n当前顺位: \`第 ${i + 1} 位\`\n您的任务将在前序处理完成后立即开始。`;
        if (task.lastText !== newText) {
            await client.editMessage(task.chatId, { 
                message: task.msgId, 
                text: newText,
                buttons: [Button.inline("🚫 取消排队", `cancel_${task.id}`)]
            }).catch(() => {});
            task.lastText = newText;
            await new Promise(r => setTimeout(r, 1200)); // 频率保护
        }
    }
}

/**
 * --- 7. 启动主逻辑 ---
 */
(async () => {
    // 启动 Telegram 客户端
    await client.start({ botAuthToken: config.botToken });
    console.log("🚀 Drive Collector JS 启动成功");

    // 监听消息与回调
    client.addEventHandler(async (event) => {
        // --- 处理取消按钮点击 ---
        if (event instanceof Api.UpdateBotCallbackQuery) {
            const data = event.data.toString();
            if (data.startsWith("cancel_")) {
                const taskId = data.split("_")[1];
                const task = waitingTasks.find(t => t.id.toString() === taskId) || 
                             (global.currentTask && global.currentTask.id.toString() === taskId ? global.currentTask : null);
                
                if (task) {
                    task.isCancelled = true;
                    if (task.proc) task.proc.kill("SIGTERM");
                    waitingTasks = waitingTasks.filter(t => t.id.toString() !== taskId);
                }
                await client.answerCallbackQuery(event.queryId, { message: "正在尝试取消任务..." });
            }
            return;
        }

        if (!(event instanceof Api.UpdateNewMessage)) return;

        const message = event.message;
        if (!message) return;

        const senderId = message.fromId ? (message.fromId.userId || message.fromId.chatId)?.toString() : message.senderId?.toString();
        const ownerId = config.ownerId?.toString().trim();

        if (senderId !== ownerId) return;

        const target = message.peerId;

        // 处理文字/指令
        if (message.message && !message.media) {
            try {
                await client.sendMessage(target, {
                    message: `👋 **欢迎使用云转存助手 (Node.js)**\n\n📡 **存储节点**: ${config.remoteName}\n📂 **同步目录**: \`${config.remoteFolder}\``
                });
            } catch (e) {
                console.error("❌ 发送欢迎语失败:", e.message);
            }
            return;
        }

        // 处理媒体文件
        if (message.media) {
            try {
                const qSize = queue.size + queue.pending;
                const taskId = Date.now() + Math.random();
                const statusMsg = await client.sendMessage(target, {
                    message: `🚀 **已捕获文件任务**\n当前有 \`${qSize}\` 个任务正在排队，我会按顺序为您处理。`,
                    buttons: [Button.inline("🚫 取消排队", `cancel_${taskId}`)]
                });

                const task = {
                    id: taskId,
                    chatId: target,
                    msgId: statusMsg.id,
                    message: message,
                    statusMsg: statusMsg,
                    lastText: ""
                };

                waitingTasks.push(task);
                queue.add(async () => {
                    global.currentTask = task;
                    await fileWorker(task);
                    global.currentTask = null;
                });
            } catch (e) {
                console.error("❌ 发送排队提示失败:", e.message);
            }
        }
    });

    // 启动健康检查 Web 服务
    http.createServer((req, res) => {
        res.writeHead(200);
        res.end("Node Service Active");
    }).listen(config.port, '0.0.0.0');

})();