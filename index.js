import { Api } from "telegram";
import http from "http";
import { config } from "./src/config/index.js";
import { client } from "./src/services/telegram.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { LinkParser } from "./src/core/LinkParser.js";
import { CloudTool } from "./src/services/rclone.js";
import { UIHelper } from "./src/ui/templates.js";
import { safeEdit } from "./src/utils/common.js";
import { SessionManager } from "./src/modules/SessionManager.js";
import { DriveConfigFlow } from "./src/modules/DriveConfigFlow.js";
import { d1 } from "./src/services/d1.js"; // 👈 新增引入 d1，用于查库
import { runBotTask } from "./src/utils/limiter.js";
import { AuthGuard } from "./src/modules/AuthGuard.js";

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
        // ---------------------------------------------------------
        // 🛡️ 1. 全局身份与状态检查 (前置拦截)
        // ---------------------------------------------------------
        let userId = null;
        let target = null;
        let isCallback = false;

        // 统一提取 ID
        if (event instanceof Api.UpdateBotCallbackQuery) {
            userId = event.userId.toString();
            // Callback 时 target 主要用于逻辑判断，不直接用于 sendMessage
            target = event.peer; 
            isCallback = true;
        } else if (event instanceof Api.UpdateNewMessage && event.message) {
            const m = event.message;
            userId = (m.fromId ? (m.fromId.userId || m.fromId.chatId) : m.senderId).toString();
            target = m.peerId;
        }

        // 如果获取到了用户ID，进行权限检查
        if (userId) {
            const role = await AuthGuard.getRole(userId);
            const ownerId = config.ownerId?.toString();
            const isOwner = userId === ownerId;

            if (!isOwner && !(await AuthGuard.can(userId, "maintenance:bypass"))) {
                // 查库获取当前模式 (默认 public)
                const setting = await d1.fetchOne("SELECT value FROM system_settings WHERE key = 'access_mode'");
                const mode = setting ? setting.value : 'public';

                if (mode !== 'public') {
                    // ⛔ 维护模式拦截
                    if (isCallback) {
                        await runBotTask(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
                            queryId: event.queryId,
                            message: "🚧 系统维护中",
                            alert: true
                        })).catch(() => {}), userId);
                    } else if (target) {
                        // 避免群组刷屏，如果是私聊则回复
                        await runBotTask(() => client.sendMessage(target, { 
                            message: "🚧 **系统维护中**\n\n当前 Bot 仅限管理员使用，请稍后访问。" 
                        }), userId);
                    }
                    return; // 停止后续逻辑
                }
            }
        }
        // ---------------------------------------------------------


        // --- 处理回调查询 (按钮点击) ---
        if (event instanceof Api.UpdateBotCallbackQuery) {
            const data = event.data.toString();
            const answer = (msg = "") => runBotTask(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: event.queryId,
                message: msg
            })).catch(() => {}), userId);

            if (data.startsWith("cancel_")) {
                const taskId = data.split("_")[1];
                // 传入 userId 以进行权限验证
                const ok = await TaskManager.cancelTask(taskId, userId);
                await answer(ok ? "指令已下达" : "任务已不存在或无权操作");
            } else if (data.startsWith("drive_")) { 
                // 处理网盘管理相关按钮
                const toast = await DriveConfigFlow.handleCallback(event, userId);
                await answer(toast || "");
                return;
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
                    if (isRefresh) await safeEdit(event.userId, event.msgId, "🔄 正在同步最新数据...", null, userId);
                    await new Promise(r => setTimeout(r, 50));
                    // 调用 CloudTool 获取数据 (传入 userId)
                    const files = await CloudTool.listRemoteFiles(userId, isRefresh);
                    const { text, buttons } = UIHelper.renderFilesPage(files, page, 6, CloudTool.isLoading());
                    await safeEdit(event.userId, event.msgId, text, buttons, userId);
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
        if (!message) return;

        // 会话拦截器 (处理密码输入等)
        const session = await SessionManager.get(userId);
        if (session) {
            const handled = await DriveConfigFlow.handleInput(event, userId, session);
            if (handled) return; // 如果被会话逻辑消费了，就停止往下执行
        }

        // 权限校验：仅允许所有者操作 (测试完记得注释掉下面这行)
        // if (userId !== config.ownerId?.toString().trim()) return;

        // --- 处理纯文本命令 ---
        if (message.message && !message.media) {
            
            // 1. /drive 命令 (主菜单)
            if (message.message === "/drive") {
                return await DriveConfigFlow.sendDriveManager(target, userId);
            }

            // 2. /unbind 命令 (解绑网盘)
            if (message.message === "/logout" || message.message === "/unbind") {
                return await DriveConfigFlow.handleUnbind(target, userId);
            }

            // 3. /status
            if (message.message === "/status") {
                // 暂用 DriveConfigFlow 或 TaskManager 处理，此处先占位
                return await runBotTask(() => client.sendMessage(target, { message: "📊 **查看状态 (转存进度)**\n\n目前没有进行中的任务。" }), userId);
            }

            // 4. /files
            if (message.message === "/files") {
                const drive = await d1.fetchOne("SELECT id FROM user_drives WHERE user_id = ?", [userId.toString()]);
                if (!drive) {
                    return await runBotTask(() => client.sendMessage(target, { 
                        message: "🚫 **未检测到绑定的网盘**\n\n请先使用 /drive 绑定网盘，然后再浏览文件。" 
                    }), userId);
                }

                const placeholder = await runBotTask(() => client.sendMessage(target, { message: "⏳ 正在拉取云端文件列表..." }), userId);
                // 人为让出事件循环 100ms
                await new Promise(r => setTimeout(r, 100));
                
                // 传入 userId 获取专属文件列表
                const files = await CloudTool.listRemoteFiles(userId);
                // 传入 CloudTool 的加载状态
                const { text, buttons } = UIHelper.renderFilesPage(files, 0, 6, CloudTool.isLoading());
                return await safeEdit(target, placeholder.id, text, buttons, userId);
            }

            // 5. 处理可能存在的消息链接 (也需要检查绑定)
            try {
                const toProcess = await LinkParser.parse(message.message, userId);
                if (toProcess && toProcess.length > 0) {
                    // 🛑 修正：增加 .toString() 保证 ID 类型一致
                    const drive = await d1.fetchOne("SELECT id FROM user_drives WHERE user_id = ?", [userId.toString()]);
                    if (!drive) {
                        return await runBotTask(() => client.sendMessage(target, { 
                            // 🛑 修正：将 /login 改为 /drive
                            message: "🚫 **未检测到绑定的网盘**\n\n请先发送 /drive 绑定网盘，然后再发送链接。" 
                        }), userId);
                    }

                    if (toProcess.length > 10) await runBotTask(() => client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` }), userId);
                    for (const msg of toProcess.slice(0, 10)) await TaskManager.addTask(target, msg, userId, "链接");
                    return;
                }
            } catch (e) {
                return await runBotTask(() => client.sendMessage(target, { message: `❌ ${e.message}` }), userId);
            }

            // 兜底回复：欢迎信息
            return await runBotTask(() => client.sendMessage(target, { 
                message: `👋 **欢迎使用云转存助手**\n\n可以直接发送文件或链接给我，我会帮您转存。\n\n/drive 🔐 绑定网盘 (账号管理)\n/files 📁 浏览文件 (云端管理)\n/status 📊 查看状态 (转存进度)` 
            }), userId);
        }

        // --- 处理直接发送的文件/视频 ---
        if (message.media) {
            const drive = await d1.fetchOne("SELECT id FROM user_drives WHERE user_id = ?", [userId.toString()]);
            if (!drive) {
                return await runBotTask(() => client.sendMessage(target, { 
                    message: "🚫 **未检测到绑定的网盘**\n\n请先使用 /drive 绑定网盘，然后再发送文件。" 
                }), userId);
            }
            await TaskManager.addTask(target, message, userId, "文件");
        }
    });
})();