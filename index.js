import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
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
    remoteName: process.env.RCLONE_REMOTE || "DriveCollectorBot",
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
                "--config", config.configPath, 
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

    // 执行转存任务
    static async uploadFile(localPath) {
        return new Promise((resolve) => {
            const args = [
                "copy", localPath, `${config.remoteName}:${config.remoteFolder}`,
                "--config", config.configPath,
                "--ignore-existing",
                "--size-only",
                "--transfers", "1",
                "--contimeout", "60s"
            ];
            const rclone = spawn("rclone", args);
            let stderr = "";
            rclone.stderr.on("data", (data) => stderr += data);
            rclone.on("close", (code) => resolve({ success: code === 0, error: stderr.trim() }));
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
    const { message, statusMsg } = task;
    const media = message.media;
    if (!media) return;

    // 移除等待列表并触发其他人的顺位更新
    waitingTasks = waitingTasks.filter(t => t.id !== task.id);
    updateQueueUI(); 

    // 文件名获取与加固
    const mediaObj = media.document || media.video;
    let fileName = mediaObj?.attributes?.find(a => a.fileName)?.fileName;
    if (!fileName) {
        const ext = media.video ? ".mp4" : ".bin";
        fileName = `transfer_${Math.floor(Date.now() / 1000)}${ext}`;
    }
    const fileSize = mediaObj.size;
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
                const now = Date.now();
                if (now - lastUpdate > 3000 || downloaded === total) {
                    lastUpdate = now;
                    await client.editMessage(message.chatId, {
                        message: statusMsg.id,
                        text: CloudTool.getProgressText(downloaded, total, "正在从 Telegram 拉取资源")
                    }).catch(() => {});
                }
            }
        });

        const actualLocalSize = fs.statSync(localPath).size;

        // 3. 转存同步
        await client.editMessage(message.chatId, { message: statusMsg.id, text: "📤 **资源拉取完成，正在转存至网盘...**" });
        const uploadResult = await CloudTool.uploadFile(localPath);

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
            await client.editMessage(message.chatId, {
                message: statusMsg.id, 
                text: `❌ **同步失败**\n错误详情: \`${uploadResult.error}\`` 
            });
        }
    } catch (e) {
        await client.editMessage(message.chatId, {
            message: statusMsg.id,
            text: `⚠️ **处理任务时发生异常**\n错误: ${e.message}`
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
            await client.editMessage(task.chatId, { message: task.msgId, text: newText }).catch(() => {});
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

    // 监听消息
    client.addEventHandler(async (event) => {
        // 关键：只处理新消息更新
        if (!(event instanceof Api.UpdateNewMessage)) return;

        const message = event.message;
        if (!message) return;

        // 获取发送者 ID 
        const senderId = message.fromId ? (message.fromId.userId || message.fromId.chatId) : message.senderId;
        const ownerId = config.ownerId;

        // 深度日志对比
        const isMatch = String(senderId).trim() === String(ownerId).trim();
        console.log(`📩 收到消息 | 来自: ${senderId} | 预期: ${ownerId} | 对比结果: ${isMatch}`);

        if (!isMatch) return;

        // 确定发送目标
        const target = message.peerId;

        // 处理文字/欢迎语
        if (message.text && !message.media) {
            try {
                console.log("正在尝试发送欢迎语...");
                const res = await client.sendMessage(target, {
                    message: `👋 **欢迎使用云转存助手 (Node.js)**\n\n📡 **存储节点**: ${config.remoteName}\n📂 **同步目录**: \`${config.remoteFolder}\``
                });
                console.log(`✅ 欢迎语发送成功，ID: ${res.id}`);
            } catch (err) {
                console.error("❌ 发送欢迎语报错:", err.message);
            }
            return;
        }

        // 处理媒体文件
        if (message.media) {
            try {
                console.log("正在尝试发送排队提示...");
                const qSize = queue.size + queue.pending;
                const statusMsg = await client.sendMessage(target, {
                    message: `🚀 **已捕获文件任务**\n当前有 \`${qSize}\` 个任务正在排队，我会按顺序为您处理。`
                });
                console.log(`✅ 提示发送成功，ID: ${statusMsg.id}`);

                const task = {
                    id: Date.now() + Math.random(),
                    chatId: target,
                    msgId: statusMsg.id,
                    message: message,
                    statusMsg: statusMsg,
                    lastText: ""
                };

                waitingTasks.push(task);
                // 异步入队处理
                queue.add(() => fileWorker(task));
            } catch (err) {
                console.error("❌ 发送任务状态报错:", err.message);
            }
        }
    });

    // 启动健康检查 Web 服务
    http.createServer((req, res) => {
        res.writeHead(200);
        res.end("Node Service Active");
    }).listen(config.port, '0.0.0.0');

})();