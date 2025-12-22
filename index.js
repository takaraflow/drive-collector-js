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
    remoteName: process.env.RCLONE_REMOTE || "mega", 
    remoteFolder: process.env.REMOTE_FOLDER || "/DriveCollectorBot",
    downloadDir: "/tmp/downloads",
    configPath: "/tmp/rclone.conf",
    port: process.env.PORT || 7860
};

if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
if (process.env.RCLONE_CONF_BASE64) fs.writeFileSync(config.configPath, Buffer.from(process.env.RCLONE_CONF_BASE64, 'base64'));

/**
 * --- 2. 任务队列配置 ---
 */
const queue = new PQueue({ concurrency: 1 });
let waitingTasks = []; 

// 文件列表内存缓存与状态锁
let remoteFilesCache = null;
let lastCacheTime = 0;
let lastRefreshTime = 0; // 刷新限流锁
let isRemoteLoading = false; 
const CACHE_TTL = 10 * 60 * 1000; // 缓存有效期 10 分钟

/**
 * --- 3. UI 模板工具库 (UIHelper) ---
 */
class UIHelper {
    /**
     * 生成 ASCII 进度条文本
     */
    static renderProgress(current, total, actionName = "正在拉取资源") {
        const percentage = (current / (total || 1) * 100).toFixed(1);
        const barLen = 20;
        const filled = Math.round(barLen * (current / (total || 1)));
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        return `⏳ **${actionName}...**\n\n` + `\`[${bar}]\` ${percentage}% (${(current / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`;
    }

    /**
     * 格式化文件列表页面
     */
    static renderFilesPage(files, page = 0, pageSize = 6) {
        const start = page * pageSize;
        const pagedFiles = files.slice(start, start + pageSize);
        const totalPages = Math.ceil(files.length / pageSize);

        let text = `📂 **目录**: \`${config.remoteFolder}\`\n\n`;
        
        if (files.length === 0 && !isRemoteLoading) {
            text += "ℹ️ 目录为空或尚未加载。";
        } else {
            pagedFiles.forEach(f => {
                const ext = path.extname(f.Name).toLowerCase();
                const emoji = [".mp4", ".mkv", ".avi"].includes(ext) ? "🎞️" : [".jpg", ".png", ".webp"].includes(ext) ? "🖼️" : [".zip", ".rar", ".7z"].includes(ext) ? "📦" : [".pdf", ".epub"].includes(ext) ? "📝" : "📄";
                const size = (f.Size / 1048576).toFixed(2) + " MB";
                const time = f.ModTime.replace("T", " ").substring(0, 16);
                text += `${emoji} **${f.Name}**\n> \`${size}\` | \`${time}\`\n\n`;
            });
        }

        text += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n📊 *第 ${page + 1}/${totalPages || 1} 页 | 共 ${files.length} 个文件*`;
        if (isRemoteLoading) text += `\n🔄 _正在同步最新数据..._`;
        
        const buttons = [
            [
                Button.inline(page <= 0 ? "🚫" : "🏠 首页", Buffer.from(`files_page_0`)),
                Button.inline(page <= 0 ? "🚫" : "⬅️ 上一页", Buffer.from(`files_page_${page - 1}`)),
                Button.inline("🔄 刷新", Buffer.from(`files_refresh_${page}`)),
                Button.inline(page >= totalPages - 1 ? "🚫" : "下一页 ➡️", Buffer.from(`files_page_${page + 1}`)),
                Button.inline(page >= totalPages - 1 ? "🚫" : "🔚 尾页", Buffer.from(`files_page_${totalPages - 1}`))
            ]
        ];
        return { text, buttons };
    }
}

/**
 * --- 4. 辅助工具函数 (Internal Helpers) ---
 */
// 安全编辑消息，统一处理异常
const safeEdit = async (chatId, msgId, text, buttons = null) => {
    try {
        await client.editMessage(chatId, { message: msgId, text, buttons, parseMode: "markdown" }).catch(() => {});
    } catch (e) {}
};

// 提取媒体元数据 (文件名、大小)
const getMediaInfo = (media) => {
    const obj = media.document || media.video || media.photo;
    if (!obj) return null;
    let name = obj.attributes?.find(a => a.fileName)?.fileName;
    if (!name) name = `transfer_${Math.floor(Date.now() / 1000)}${media.video ? ".mp4" : (media.photo ? ".jpg" : ".bin")}`;
    const size = obj.size || (obj.sizes ? obj.sizes[obj.sizes.length - 1].size : 0);
    return { name, size };
};

// 统一更新任务状态 (带取消按钮)
const updateStatus = async (task, text, isFinal = false) => {
    const buttons = isFinal ? null : [Button.inline(task.proc ? "🚫 取消转存" : "🚫 取消任务", Buffer.from(`cancel_${task.id}`))];
    await safeEdit(task.chatId, task.msgId, text, buttons);
};

/**
 * --- 5. 云端操作工具库 (CloudTool) ---
 */
class CloudTool {
    static rcloneExec(args) {
        return spawn("rclone", [...args, "--config", path.resolve(config.configPath)]);
    }

    static async getRemoteFileInfo(fileName) {
        return new Promise((resolve) => {
            const rclone = this.rcloneExec(["lsjson", `${config.remoteName}:${config.remoteFolder}`, "--files-only"]);
            let output = "";
            rclone.stdout.on("data", (data) => output += data);
            rclone.on("close", () => {
                try { resolve(JSON.parse(output).find(f => f.Name === fileName) || null); } catch (e) { resolve(null); }
            });
        });
    }

    static async listRemoteFiles(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && remoteFilesCache && (now - lastCacheTime < CACHE_TTL)) {
            return remoteFilesCache;
        }
        if (isRemoteLoading && remoteFilesCache) return remoteFilesCache;

        isRemoteLoading = true; 
        return new Promise((resolve) => {
            const rclone = this.rcloneExec(["lsjson", `${config.remoteName}:${config.remoteFolder}`, "--files-only", "--tpslimit", "2"]);
            let output = "";
            rclone.stdout.on("data", (data) => output += data);
            rclone.on("close", () => {
                try { 
                    const files = JSON.parse(output).sort((a, b) => new Date(b.ModTime) - new Date(a.ModTime));
                    remoteFilesCache = files;
                    lastCacheTime = Date.now();
                    resolve(files);
                } catch (e) { resolve(remoteFilesCache || []); }
                finally { isRemoteLoading = false; }
            });
        });
    }

    static async uploadFile(localPath, task) {
        return new Promise((resolve) => {
            const args = ["copy", localPath, `${config.remoteName}:${config.remoteFolder}`, "--ignore-existing", "--size-only", "--transfers", "1", "--contimeout", "60s", "--progress", "--use-json-log"];
            task.proc = this.rcloneExec(args);
            let stderr = "";
            let lastUpdate = 0;

            task.proc.stderr.on("data", (data) => {
                const lines = data.toString().split('\n');
                for (let line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const stats = JSON.parse(line);
                        const s = stats.stats || stats;
                        if (s.percentage !== undefined) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                updateStatus(task, UIHelper.renderProgress(s.bytes || 0, s.totalBytes || 1, "正在转存网盘"));
                            }
                        }
                    } catch (e) {
                        const match = line.match(/(\d+)%/);
                        if (match) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                updateStatus(task, `⏳ **正在转存网盘...**\n\n${UIHelper.renderProgress(parseInt(match[1]), 100, "转存进度")}`);
                            }
                        }
                        stderr += line; 
                    }
                }
            });
            task.proc.on("close", (code) => resolve({ success: code === 0, error: stderr.trim() }));
        });
    }
}

const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, { connectionRetries: 5 });

/**
 * --- 6. 核心处理 Worker ---
 */
async function fileWorker(task) {
    const { message, id } = task;
    if (!message.media) return;

    waitingTasks = waitingTasks.filter(t => t.id !== id);
    updateQueueUI(); 

    const info = getMediaInfo(message.media);
    if (!info) return await updateStatus(task, "❌ 无法解析该媒体文件信息。", true);

    const localPath = path.join(config.downloadDir, info.name);

    try {
        const remoteFile = await CloudTool.getRemoteFileInfo(info.name);
        if (remoteFile && Math.abs(remoteFile.Size - info.size) < 1024) {
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

        await updateStatus(task, "📤 **资源拉取完成，正在转存至网盘...**");
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

async function updateQueueUI() {
    for (let i = 0; i < Math.min(waitingTasks.length, 5); i++) {
        const task = waitingTasks[i];
        const newText = `🕒 **任务排队中...**\n\n当前顺位: \`第 ${i + 1} 位\``;
        if (task.lastText !== newText) {
            await updateStatus(task, newText);
            task.lastText = newText;
            await new Promise(r => setTimeout(r, 1200));
        }
    }
}

async function addNewTask(target, mediaMessage, customLabel = "") {
    const taskId = Date.now() + Math.random();
    const statusMsg = await client.sendMessage(target, {
        message: `🚀 **已捕获${customLabel}任务**\n正在排队处理...`,
        buttons: [Button.inline("🚫 取消排队", Buffer.from(`cancel_${taskId}`))]
    });
    const task = { id: taskId, chatId: target, msgId: statusMsg.id, message: mediaMessage, lastText: "" };
    waitingTasks.push(task);
    queue.add(async () => { global.currentTask = task; await fileWorker(task); global.currentTask = null; });
}

/**
 * --- 7. 启动主逻辑 ---
 */
(async () => {
    await client.start({ botAuthToken: config.botToken });
    console.log("🚀 Drive Collector JS 启动成功");

    client.addEventHandler(async (event) => {
        if (event instanceof Api.UpdateBotCallbackQuery) {
            const data = event.data.toString();
            const answer = (msg = "") => client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: event.queryId,
                message: msg
            })).catch(() => {});

            if (data.startsWith("cancel_")) {
                const taskId = data.split("_")[1];
                const task = waitingTasks.find(t => t.id.toString() === taskId) || (global.currentTask && global.currentTask.id.toString() === taskId ? global.currentTask : null);
                if (task) {
                    task.isCancelled = true;
                    if (task.proc) task.proc.kill("SIGTERM");
                    waitingTasks = waitingTasks.filter(t => t.id.toString() !== taskId);
                }
                await answer("指令已下达");
            } else if (data.startsWith("files_page_") || data.startsWith("files_refresh_")) {
                const isRefresh = data.startsWith("files_refresh_");
                const page = parseInt(data.split("_")[2]);

                if (isRefresh) {
                    const now = Date.now();
                    if (now - lastRefreshTime < 10000) return await answer(`🕒 刷新太快了，请 ${Math.ceil((10000 - (now - lastRefreshTime)) / 1000)} 秒后再试`);
                    lastRefreshTime = now;
                }

                if (!isNaN(page)) {
                    if (isRefresh) await safeEdit(event.userId, event.msgId, "🔄 正在同步最新数据...");
                    // 给异步刷新一个微小的物理延迟，确保 UI 先变更
                    await new Promise(r => setTimeout(r, 50));
                    const files = await CloudTool.listRemoteFiles(isRefresh);
                    const { text, buttons } = UIHelper.renderFilesPage(files, page);
                    await safeEdit(event.userId, event.msgId, text, buttons);
                }
                await answer(isRefresh ? "刷新成功" : "");
            } else {
                await answer();
            }
            return;
        }

        if (!(event instanceof Api.UpdateNewMessage)) return;
        const message = event.message;
        if (!message || (message.fromId ? (message.fromId.userId || message.fromId.chatId)?.toString() : message.senderId?.toString()) !== config.ownerId?.toString().trim()) return;

        const target = message.peerId;

        if (message.message && !message.media) {
            if (message.message === "/files") {
                const placeholder = await client.sendMessage(target, { message: "⏳ 正在拉取云端文件列表..." });
                // 人为让出事件循环 100ms，确保占位符消息的发送回执被优先处理
                await new Promise(r => setTimeout(r, 100));
                const files = await CloudTool.listRemoteFiles();
                const { text, buttons } = UIHelper.renderFilesPage(files, 0);
                return await safeEdit(target, placeholder.id, text, buttons);
            }

            const match = message.message.match(/https:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
            if (match) {
                try {
                    const [_, channel, msgIdStr] = match;
                    const msgId = parseInt(msgIdStr);
                    const ids = Array.from({ length: 19 }, (_, i) => msgId - 9 + i);
                    const result = await client.getMessages(channel, { ids });

                    if (result && Array.isArray(result) && result.length > 0) {
                        const validMsgs = result.filter(m => m && typeof m === 'object');
                        const targetMsg = validMsgs.find(m => m.id === msgId);
                        if (targetMsg) {
                            let toProcess = [];
                            if (targetMsg.groupedId) {
                                toProcess = validMsgs.filter(m => m.groupedId && m.groupedId.toString() === targetMsg.groupedId.toString() && m.media);
                            } else if (targetMsg.media) {
                                toProcess = [targetMsg];
                            }
                            if (toProcess.length > 0) {
                                const finalProcess = toProcess.slice(0, 10);
                                if (toProcess.length > 10) await client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` });
                                for (const msg of finalProcess) await addNewTask(target, msg, "链接");
                                return;
                            }
                        }
                    }
                    await client.sendMessage(target, { message: "ℹ️ 未能从该链接中解析到有效的媒体消息。" });
                    return;
                } catch (e) {
                    await client.sendMessage(target, { message: `❌ 链接解析失败: ${e.message}` });
                    return;
                }
            }
            return await client.sendMessage(target, { message: `👋 **欢迎使用云转存助手**\n\n📡 **节点**: ${config.remoteName}\n📂 **目录**: \`${config.remoteFolder}\`` });
        }

        if (message.media) await addNewTask(target, message, "文件");
    });

    http.createServer((req, res) => {
        res.writeHead(200);
        res.end("Node Service Active");
    }).listen(config.port, '0.0.0.0');

})();