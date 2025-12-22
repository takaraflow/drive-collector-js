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
 * --- 2. 全局状态变量 ---
 */
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
     * 格式化文件列表页面 (样式：文件名+缩进详情)
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
        
        // 生成分页导航按钮
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
    /**
     * 基础执行器：统一管理 Rclone 进程生成
     */
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
            // 增加降权参数，确保并发查询不至于彻底拖慢转存
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
                // 修复：针对缓冲区积压导致的大文件进度不更新，进行按行切割
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
                        // 正则兜底解析，确保进度条绝对能动
                        const match = line.match(/(\d+)%/);
                        if (match) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                const pct = parseInt(match[1]);
                                updateStatus(task, `⏳ **正在转存网盘...**\n\n${UIHelper.renderProgress(pct, 100, "转存进度")}`);
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

/**
 * --- 6. 任务管理调度中心 (TaskManager) ---
 */
class TaskManager {
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

            await updateStatus(task, "📤 **资源拉取完成，正在转存至网盘...**");
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

/**
 * --- 7. 链接解析与消息探测逻辑 (LinkParser) ---
 */
class LinkParser {
    /**
     * 核心解析函数：从文本中探测链接并提取相关媒体消息
     */
    static async parse(text) {
        // 匹配 Telegram 消息链接逻辑
        const match = text.match(/https:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
        if (!match) return null;

        const [_, channel, msgIdStr] = match;
        const msgId = parseInt(msgIdStr);

        try {
            // 构建 ID 探测范围 (±9)，用于捕获关联的消息组
            const ids = Array.from({ length: 19 }, (_, i) => msgId - 9 + i);
            const result = await client.getMessages(channel, { ids });

            if (!result || !Array.isArray(result) || result.length === 0) return null;

            const validMsgs = result.filter(m => m && typeof m === 'object');
            const targetMsg = validMsgs.find(m => m.id === msgId);

            if (!targetMsg) return null;

            let toProcess = [];
            if (targetMsg.groupedId) {
                // 逻辑：如果存在媒体组，提取同一组内的所有带媒体的消息
                toProcess = validMsgs.filter(m => 
                    m.groupedId && 
                    m.groupedId.toString() === targetMsg.groupedId.toString() && 
                    m.media
                );
            } else if (targetMsg.media) {
                // 逻辑：如果不是组，但本身带媒体，则单选
                toProcess = [targetMsg];
            }

            return toProcess;
        } catch (e) {
            throw new Error(`链接解析失败: ${e.message}`);
        }
    }
}

const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, { connectionRetries: 5 });

/**
 * --- 8. 启动主逻辑 ---
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
                const ok = TaskManager.cancelTask(taskId);
                await answer(ok ? "指令已下达" : "任务已不存在");
            } else if (data.startsWith("files_page_") || data.startsWith("files_refresh_")) {
                const isRefresh = data.startsWith("files_refresh_");
                const page = parseInt(data.split("_")[2]);

                // 刷新按钮限流
                if (isRefresh) {
                    const now = Date.now();
                    if (now - lastRefreshTime < 10000) return await answer(`🕒 刷新太快了，请 ${Math.ceil((10000 - (now - lastRefreshTime)) / 1000)} 秒后再试`);
                    lastRefreshTime = now;
                }

                if (!isNaN(page)) {
                    // 触发“正在同步”的 UI 状态
                    if (isRefresh) await safeEdit(event.userId, event.msgId, "🔄 正在同步最新数据...");
                    await new Promise(r => setTimeout(r, 50));
                    const files = await CloudTool.listRemoteFiles(isRefresh);
                    const { text, buttons } = UIHelper.renderFilesPage(files, page);
                    await safeEdit(event.userId, event.msgId, text, buttons);
                }
                await answer(isRefresh ? "刷新成功" : "");
            } else {
                await answer(); // 兜底 🚫 等无效按钮
            }
            return;
        }

        if (!(event instanceof Api.UpdateNewMessage)) return;
        const message = event.message;
        // 权限校验：仅允许所有者操作
        if (!message || (message.fromId ? (message.fromId.userId || message.fromId.chatId)?.toString() : message.senderId?.toString()) !== config.ownerId?.toString().trim()) return;

        const target = message.peerId;

        if (message.message && !message.media) {
            // 处理 /files 文件列表命令
            if (message.message === "/files") {
                const placeholder = await client.sendMessage(target, { message: "⏳ 正在拉取云端文件列表..." });
                // 人为让出事件循环 100ms，确保占位符消息的发送回执被优先处理
                await new Promise(r => setTimeout(r, 100));
                const files = await CloudTool.listRemoteFiles();
                const { text, buttons } = UIHelper.renderFilesPage(files, 0);
                return await safeEdit(target, placeholder.id, text, buttons);
            }

            // 处理可能存在的消息链接
            try {
                const toProcess = await LinkParser.parse(message.message);
                if (toProcess) {
                    if (toProcess.length > 0) {
                        const finalProcess = toProcess.slice(0, 10);
                        if (toProcess.length > 10) await client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` });
                        for (const msg of finalProcess) await TaskManager.addTask(target, msg, "链接");
                    } else {
                        await client.sendMessage(target, { message: "ℹ️ 未能从该链接中解析到有效的媒体消息。" });
                    }
                    return;
                }
            } catch (e) {
                return await client.sendMessage(target, { message: `❌ ${e.message}` });
            }

            // 兜底回复：欢迎信息
            return await client.sendMessage(target, { message: `👋 **欢迎使用云转存助手**\n\n📡 **节点**: ${config.remoteName}\n📂 **目录**: \`${config.remoteFolder}\`` });
        }

        // 处理直接发送的文件/视频
        if (message.media) await TaskManager.addTask(target, message, "文件");
    });

    // 启动健康检查 Web 服务
    http.createServer((req, res) => {
        res.writeHead(200);
        res.end("Node Service Active");
    }).listen(config.port, '0.0.0.0');

})();