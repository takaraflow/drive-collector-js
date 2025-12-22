import { Api } from "telegram";
import http from "http";
import { config } from "./src/config/index.js";
import { client } from "./src/services/telegram.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { LinkParser } from "./src/core/LinkParser.js";
import { CloudTool } from "./src/services/rclone.js";
import { UIHelper } from "./src/ui/templates.js";
import { safeEdit } from "./src/utils/common.js";

// 刷新限流锁 (保留在主入口)
let lastRefreshTime = 0; 

/**
 * --- 启动主逻辑 ---
 */
(async () => {
    // 1. 先启动 Telegram 客户端
    await client.start({ botAuthToken: config.botToken });
    console.log("🚀 Telegram 客户端已连接");

    // 2. 【关键】先开启端口监听，告诉 Zeabur “我已经跑起来了”
    http.createServer((req, res) => {
        res.writeHead(200);
        res.end("Node Service Active");
    }).listen(config.port, '0.0.0.0', () => {
        console.log(`📡 健康检查端口 ${config.port} 已就绪`);
    });

    // 3. 异步初始化任务（不使用 await，让它在后台慢慢跑）
    // 这样即便数据库响应慢，也不会阻塞容器的“存活证明”
    TaskManager.init().then(() => {
        console.log("✅ 历史任务初始化扫描完成");
    }).catch(err => {
        console.error("❌ 任务初始化过程中发生错误:", err);
    });

    client.addEventHandler(async (event) => {
        // --- 处理回调查询 (按钮点击) ---
        if (event instanceof Api.UpdateBotCallbackQuery) {
            const userId = event.userId.toString(); // 获取操作者的 ID
            const data = event.data.toString();
            const answer = (msg = "") => client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: event.queryId,
                message: msg
            })).catch(() => {});

            if (data.startsWith("cancel_")) {
                const taskId = data.split("_")[1];
                // 传入 userId 以进行权限验证
                const ok = await TaskManager.cancelTask(taskId, userId);
                await answer(ok ? "指令已下达" : "任务已不存在或无权操作");
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
                    // 调用 CloudTool 获取数据 (传入 userId)
                    const files = await CloudTool.listRemoteFiles(userId, isRefresh);
                    const { text, buttons } = UIHelper.renderFilesPage(files, page, 6, CloudTool.isLoading());
                    await safeEdit(event.userId, event.msgId, text, buttons);
                }
                await answer(isRefresh ? "刷新成功" : "");
            } else {
                await answer(); // 兜底 🚫 等无效按钮
            }
            return;
        }

        // --- 处理新消息 ---
        if (!(event instanceof Api.UpdateNewMessage)) return;
        const message = event.message;
        // 权限校验：仅允许所有者操作
        if (!message || (message.fromId ? (message.fromId.userId || message.fromId.chatId)?.toString() : message.senderId?.toString()) !== config.ownerId?.toString().trim()) return;

        // 获取发送者的 ID
        const userId = (message.fromId ? (message.fromId.userId || message.fromId.chatId) : message.senderId).toString();
        const target = message.peerId;

        if (message.message && !message.media) {
            // 处理 /files 文件列表命令
            if (message.message === "/files") {
                const placeholder = await client.sendMessage(target, { message: "⏳ 正在拉取云端文件列表..." });
                // 人为让出事件循环 100ms，确保占位符消息的发送回执被优先处理
                await new Promise(r => setTimeout(r, 100));
                
                // 传入 userId 获取专属文件列表
                const files = await CloudTool.listRemoteFiles(userId);
                // 传入 CloudTool 的加载状态
                const { text, buttons } = UIHelper.renderFilesPage(files, 0, 6, CloudTool.isLoading());
                return await safeEdit(target, placeholder.id, text, buttons);
            }

            // 处理可能存在的消息链接
            try {
                const toProcess = await LinkParser.parse(message.message);
                if (toProcess) {
                    if (toProcess.length > 0) {
                        const finalProcess = toProcess.slice(0, 10);
                        if (toProcess.length > 10) await client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` });
                        for (const msg of finalProcess) await TaskManager.addTask(target, msg, userId, "链接");
                    } else {
                        await client.sendMessage(target, { message: "ℹ️ 未能从该链接中解析到有效的媒体消息。" });
                    }
                    return;
                }
            } catch (e) {
                return await client.sendMessage(target, { message: `❌ ${e.message}` });
            }

            // 兜底回复：欢迎信息
            return await client.sendMessage(target, { message: `👋 **欢迎使用云转存助手**\n\n📡 **节点**: ${config.remoteName}\n🆔 **用户ID**: \`${userId}\`` });
        }

        // 处理直接发送的文件/视频
        if (message.media) await TaskManager.addTask(target, message, userId, "文件");
    });
})();