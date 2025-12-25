import { Api } from "telegram";
import { config } from "../config/index.js";
import { client } from "../services/telegram.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { SessionManager } from "../modules/SessionManager.js";
import { DriveConfigFlow } from "../modules/DriveConfigFlow.js";
import { TaskManager } from "../core/TaskManager.js";
import { LinkParser } from "../core/LinkParser.js";
import { UIHelper } from "../ui/templates.js";
import { CloudTool } from "../services/rclone.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { safeEdit, escapeHTML } from "../utils/common.js";
import { runBotTask, runBotTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import fs from "fs";
import path from "path";

/**
 * 消息分发器 (Dispatcher)
 * 职责：
 * 1. 接收所有 Telegram 事件
 * 2. 执行全局权限/状态检查
 * 3. 将请求路由到正确的业务模块 (Router)
 */
export class Dispatcher {
    // 🆕 媒体组缓存：用于聚合短时间内具有相同 groupedId 的消息
    static groupBuffers = new Map();
    
    // 防止刷新按钮被疯狂点击
    static lastRefreshTime = 0;

    /**
     * 主入口：处理所有事件
     * @param {Api.TypeUpdate} event 
     */
    static async handle(event) {
        // 1. 提取上下文信息
        const ctx = this._extractContext(event);
        if (!ctx.userId) return; // 无法识别用户，忽略

        // 2. 全局前置守卫 (权限、维护模式)
        const passed = await this._globalGuard(event, ctx);
        if (!passed) return;

        // 3. 路由分发
        // 使用 className 检查替代 instanceof，提高鲁棒性并方便测试
        if (event.className === 'UpdateBotCallbackQuery') {
            await this._handleCallback(event, ctx);
        } else if (event.className === 'UpdateNewMessage' && event.message) {
            await this._handleMessage(event, ctx);
        }
    }

    /**
     * [私有] 提取上下文 (User ID, Chat ID 等)
     */
    static _extractContext(event) {
        let userId = null;
        let target = null;
        let isCallback = false;

        if (event.className === 'UpdateBotCallbackQuery') {
            userId = event.userId.toString();
            target = event.peer;
            isCallback = true;
        } else if (event.className === 'UpdateNewMessage' && event.message) {
            const m = event.message;
            userId = (m.fromId ? (m.fromId.userId || m.fromId.chatId) : m.senderId).toString();
            target = m.peerId;
        }
        return { userId, target, isCallback };
    }

    /**
     * [私有] 全局守卫
     * @returns {Promise<boolean>} 是否允许通过
     */
    static async _globalGuard(event, { userId, target, isCallback }) {
        // 🚀 性能优化：并发执行权限检查和设置查询
        const [role, mode] = await Promise.all([
            AuthGuard.getRole(userId),
            SettingsRepository.get("access_mode", "public")
        ]);

        const isOwner = userId === config.ownerId?.toString();

        if (!isOwner && !(await AuthGuard.can(userId, "maintenance:bypass"))) {
            if (mode !== 'public') {
                const text = STRINGS.system.maintenance_mode;
                if (isCallback) {
                    await runBotTaskWithRetry(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
                        queryId: event.queryId,
                        message: STRINGS.system.maintenance_alert,
                        alert: true
                    })).catch(() => {}), userId, {}, false, 3);
                } else if (target) {
                    await runBotTaskWithRetry(() => client.sendMessage(target, {
                        message: text,
                        parseMode: "html"
                    }), userId, {}, false, 3);
                }
                return false; // 拦截
            }
        }
        return true;
    }

    /**
     * [私有] 处理回调按钮
     */
    static async _handleCallback(event, { userId }) {
        const data = event.data.toString();
        const answer = (msg = "") => runBotTaskWithRetry(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: event.queryId,
            message: msg
        })).catch(() => {}), userId, {}, false, 3);

        if (data === "noop") return await answer();

        if (data.startsWith("cancel_")) {
            const taskId = data.split("_")[1];
            const ok = await TaskManager.cancelTask(taskId, userId);
            await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);
        
        } else if (data.startsWith("drive_")) { 
            const toast = await DriveConfigFlow.handleCallback(event, userId);
            await answer(toast || "");
        
        } else if (data.startsWith("files_")) {
            await this._handleFilesCallback(event, data, userId, answer);
        
        } else {
            await answer(); 
        }
    }

    /**
     * [私有] 处理文件列表相关的回调 (逻辑稍微复杂，单独拆分)
     */
    static async _handleFilesCallback(event, data, userId, answerCallback) {
        const isRefresh = data.startsWith("files_refresh_");
        const page = parseInt(data.split("_")[2]);

        if (isRefresh) {
            const now = Date.now();
            if (now - this.lastRefreshTime < 10000) return await answerCallback(format(STRINGS.files.refresh_limit, { 
                seconds: Math.ceil((10000 - (now - this.lastRefreshTime)) / 1000) 
            }));
            this.lastRefreshTime = now;
        }

        if (!isNaN(page)) {
            if (isRefresh) await safeEdit(event.userId, event.msgId, STRINGS.files.syncing, null, userId);
            await new Promise(r => setTimeout(r, 50));
            
            const files = await CloudTool.listRemoteFiles(userId, isRefresh);
            const { text, buttons } = UIHelper.renderFilesPage(files, page, 6, CloudTool.isLoading());
            await safeEdit(event.userId, event.msgId, text, buttons, userId);
        }
        await answerCallback(isRefresh ? STRINGS.files.refresh_success : "");
    }

    /**
     * [私有] 处理普通消息
     */
    static async _handleMessage(event, { userId, target }) {
        const message = event.message;
        const text = message.message;

        // 🚀 性能优化：为 /start 命令添加快速路径，只检查维护模式，避免查询用户角色
        if (text === "/start") {
            const mode = await SettingsRepository.get("access_mode", "public");
            const isOwner = userId === config.ownerId?.toString();

            if (!isOwner && mode !== 'public') {
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: STRINGS.system.maintenance_mode,
                    parseMode: "html"
                }), userId, {}, false, 3);
            }

            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.system.welcome,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        // 1. 会话拦截 (密码输入等)
        const session = await SessionManager.get(userId);
        if (session) {
            const handled = await DriveConfigFlow.handleInput(event, userId, session);
            if (handled) return;
        }

        // 🚀 性能优化：并发获取网盘设置，避免串行查询
        const [defaultDriveId, selectedDrive] = await Promise.all([
            SettingsRepository.get(`default_drive_${userId}`, null),
            DriveRepository.findByUserId(userId)
        ]);

        let finalSelectedDrive = selectedDrive;
        if (defaultDriveId && !selectedDrive) {
            finalSelectedDrive = await DriveRepository.findById(defaultDriveId);
        }

        // 2. 文本命令路由
        if (text && !message.media) {
            switch (text.split(' ')[0]) { // 只匹配第一段，如 /drive
                case "/drive":
                    return await DriveConfigFlow.sendDriveManager(target, userId);
                case "/logout":
                case "/unbind":
                    return await DriveConfigFlow.handleUnbind(target, userId);
                case "/files":
                    return await this._handleFilesCommand(target, userId);
                case "/status":
                    return await this._handleStatusCommand(target, userId, text);
                case "/help":
                    return await this._handleHelpCommand(target, userId);
                // 更多命令可在此添加...
            }

            // 3. 尝试解析链接
            try {
                const toProcess = await LinkParser.parse(text, userId);
                if (toProcess && toProcess.length > 0) {
                    if (!selectedDrive) return await this._sendBindHint(target, userId);

                    if (toProcess.length > 10) await runBotTaskWithRetry(() => client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` }), userId, {}, false, 3);
                    for (const msg of toProcess.slice(0, 10)) await TaskManager.addTask(target, msg, userId, "链接");
                    return;
                }
            } catch (e) {
                return await runBotTaskWithRetry(() => client.sendMessage(target, { message: `❌ ${escapeHTML(e.message)}`, parseMode: "html" }), userId, {}, false, 3);
            }

            // 4. 通用兜底回复：
            // 如果是纯文本消息（包括未匹配的命令），且未被上述逻辑处理，则发送欢迎语。
            return await runBotTaskWithRetry(() => client.sendMessage(target, { 
                message: STRINGS.system.welcome,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        // 5. 处理带媒体的消息 (文件/视频/图片)
        if (message.media) {
            if (!selectedDrive) return await this._sendBindHint(target, userId);

            // 🚀 核心逻辑：如果是媒体组消息
            if (message.groupedId) {
                const gid = message.groupedId.toString();
                
                // 如果是该组的第一条消息，启动收集计时器
                if (!this.groupBuffers.has(gid)) {
                    this.groupBuffers.set(gid, {
                        messages: [],
                        timer: setTimeout(async () => {
                            const buffer = this.groupBuffers.get(gid);
                            this.groupBuffers.delete(gid);
                            // 收集完毕，交给 TaskManager 批量处理
                            await TaskManager.addBatchTasks(target, buffer.messages, userId);
                        }, 800) // 800ms 足够收齐一组消息
                    });
                }
                
                // 将消息加入缓存
                this.groupBuffers.get(gid).messages.push(message);
                return;
            }

            // 零散文件逻辑保持不动
            await TaskManager.addTask(target, message, userId, "文件");
            return;
        }
    }

    /**
     * [私有] 处理 /files 命令 (优化响应速度)
     */
    static async _handleFilesCommand(target, userId) {
        // 1. 立即响应：发送占位消息，先不检查网盘绑定以提升响应速度
        const placeholder = await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: "📂 正在加载文件列表..."
        }), userId, { priority: PRIORITY.UI }, false, 3);

        // 2. 异步处理：并发检查网盘绑定和获取文件列表
        (async () => {
            try {
                const drive = await DriveRepository.findByUserId(userId);
                if (!drive) {
                    await safeEdit(target, placeholder.id, STRINGS.drive.no_drive_found, null, userId);
                    return;
                }

                // 如果 listRemoteFiles 命中了 Redis 或内存缓存，这里会非常快
                const files = await CloudTool.listRemoteFiles(userId);
                const { text, buttons } = UIHelper.renderFilesPage(files, 0, 6, CloudTool.isLoading());
                await safeEdit(target, placeholder.id, text, buttons, userId);

                // 如果发现数据是加载中的（例如缓存过期正在后台刷新），可以考虑在这里逻辑
            } catch (e) {
                console.error("Files command async error:", e);
                await safeEdit(target, placeholder.id, "❌ 无法获取文件列表，请稍后重试。", null, userId);
            }
        })();
    }

    /**
     * [私有] 处理 /status 命令
     */
    static async _handleStatusCommand(target, userId, fullText) {
        const parts = fullText.split(' ');
        const subCommand = parts.length > 1 ? parts[1].toLowerCase() : 'general';
        
        let message = '';
        let buttons = null;
        
        switch (subCommand) {
            case 'queue':
                message = this._getQueueStatus();
                break;
            case 'user':
                message = await this._getUserStatus(userId);
                break;
            case 'general':
            default:
                message = await this._getGeneralStatus(userId);
        }
        
        return await runBotTaskWithRetry(() => client.sendMessage(target, { 
            message: message,
            buttons: buttons,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 获取队列状态
     */
    static _getQueueStatus() {
        const waitingCount = TaskManager.waitingTasks.length;
        const currentTask = TaskManager.currentTask;
        
        let status = format(STRINGS.status.header, {}) + '\n\n';
        status += format(STRINGS.status.queue_title, {}) + '\n';
        status += format(STRINGS.status.waiting_tasks, { count: waitingCount }) + '\n';
        status += format(STRINGS.status.current_task, { count: currentTask ? '1' : '0' }) + '\n';
        
        if (currentTask) {
            status += '\n' + format(STRINGS.status.current_file, { name: escapeHTML(currentTask.fileName) }) + '\n';
        }
        
        return status;
    }

    /**
     * [私有] 获取用户状态
     */
    static async _getUserStatus(userId) {
        // 获取用户的任务历史
        const tasks = await TaskRepository.findByUserId(userId, 10); // 获取最近10个任务
        
        let status = format(STRINGS.status.user_history, {}) + '\n\n';
        
        if (!tasks || tasks.length === 0) {
            status += STRINGS.status.no_tasks;
            return status;
        }
        
        tasks.forEach((task, index) => {
            const taskStatus = task.status === 'completed' ? '✅' : 
                              task.status === 'failed' ? '❌' : 
                              task.status === 'cancelled' ? '🚫' : '🔄';
            const statusText = task.status === 'completed' ? '完成' : 
                              task.status === 'failed' ? '失败' : 
                              task.status === 'cancelled' ? '已取消' : '处理中';
            status += format(STRINGS.status.task_item, {
                index: index + 1,
                status: taskStatus,
                name: escapeHTML(task.file_name || '未知文件'),
                statusText: statusText
            }) + '\n';
        });
        
        return status;
    }

    /**
     * [私有] 获取通用状态
     */
    static async _getGeneralStatus(userId) {
        const drive = await DriveRepository.findByUserId(userId);
        const waitingCount = TaskManager.waitingTasks.length;
        const currentTask = TaskManager.currentTask;
        
        let status = format(STRINGS.status.header, {}) + '\n\n';
        
        // 网盘状态
        status += format(STRINGS.status.drive_status, {
            status: drive ? `✅ 已绑定 (${drive.type})` : '❌ 未绑定'
        }) + '\n\n';
        
        // 队列状态
        status += format(STRINGS.status.queue_title, {}) + '\n';
        status += format(STRINGS.status.waiting_tasks, { count: waitingCount }) + '\n';
        status += format(STRINGS.status.current_task, { count: currentTask ? '1' : '0' }) + '\n';
        
        // 系统信息
        status += '\n' + format(STRINGS.status.system_info, {}) + '\n';
        status += format(STRINGS.status.uptime, { uptime: this._getUptime() }) + '\n';
        status += format(STRINGS.status.service_status, { status: '✅ 正常' });
        
        return status;
    }

    /**
     * [私有] 获取运行时间
     */
    static _getUptime() {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    /**
     * [私有] 处理 /help 命令
     */
    static async _handleHelpCommand(target, userId) {
        // 读取版本号
        const pkgPath = path.join(process.cwd(), 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const version = pkg.version || 'unknown';

        const message = format(STRINGS.system.help, { version });
        
        return await runBotTaskWithRetry(() => client.sendMessage(target, { 
            message: message,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 发送绑定提示
     */
    static async _sendBindHint(target, userId) {
        return await runBotTaskWithRetry(() => client.sendMessage(target, { 
            message: STRINGS.drive.no_drive_found,
            parseMode: "html"
        }), userId, {}, false, 3);
    }
}