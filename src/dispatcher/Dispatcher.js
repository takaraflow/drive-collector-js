import { Api } from "telegram";
import { Button } from "telegram/tl/custom/button.js";
import { config } from "../config/index.js";
import { client, isClientActive } from "../services/telegram.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { SessionManager } from "../modules/SessionManager.js";
import { DriveConfigFlow } from "../modules/DriveConfigFlow.js";
import { TaskManager } from "../processor/TaskManager.js";
import { LinkParser } from "../processor/LinkParser.js";
import { UIHelper } from "../ui/templates.js";
import { CloudTool } from "../services/rclone.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { ApiKeyRepository } from "../repositories/ApiKeyRepository.js";
import { safeEdit, escapeHTML } from "../utils/common.js";
import { runBotTask, runBotTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { NetworkDiagnostic } from "../utils/NetworkDiagnostic.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { cache } from "../services/CacheService.js";
import { queueService } from "../services/QueueService.js";
import { logger } from "../services/logger/index.js";
import { localCache } from "../utils/LocalCache.js";
import mediaGroupBuffer from "../services/MediaGroupBuffer.js";
import fs from "fs";
import path from "path";

const log = logger.withModule('Dispatcher');
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const appVersion = packageJson.version || 'unknown';

// 创建带 perf 上下文的 logger 用于性能日志
const logPerf = () => log.withContext({ perf: true });
const FILES_REFRESH_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 50;

// 命令权限映射表 (RBAC)
const COMMAND_PERMISSIONS = {
    // 网盘管理 (高危)
    "/drive":             "drive:edit",
    "/logout":            "drive:edit",
    "/unbind":            "drive:edit",
    "/remote_folder":     "drive:edit",
    "/set_remote_folder": "drive:edit",
    
    // 系统管理
    "/diagnosis":         "system:admin",
    "/open_service":      "system:admin",
    "/close_service":     "system:admin",
    "/status_public":     "system:admin",
    "/status_private":    "system:admin",
    
    // 用户管理
    "/pro_admin":         "user:manage",
    "/de_admin":          "user:manage",
    "/ban":               "user:manage",
    "/unban":             "user:manage"
};

/**
 * 消息分发器 (Dispatcher)
 * 职责：
 * 1. 接收所有 Telegram 事件
 * 2. 执行全局权限/状态检查
 * 3. 将请求路由到正确的业务模块 (Router)
 */
export class Dispatcher {
    // 媒体组缓存：用于聚合短时间内具有相同 groupedId 的消息
    static groupBuffers = new Map();

    // 防止刷新按钮被疯狂点击
    static lastRefreshTime = 0;

    /**
     * 初始化 Dispatcher
     */
    static async init() {
        try {
            // 恢复媒体组缓冲区
            await mediaGroupBuffer.restore();
            log.info('MediaGroupBuffer restored successfully');
        } catch (error) {
            log.error('Failed to restore MediaGroupBuffer:', error);
        }
    }

    /**
     * 主入口：处理所有事件
     * @param {Api.TypeUpdate} event 
     */
    static async handle(event) {
        const start = Date.now();
        
        // 1. 提取上下文信息
        const ctxStart = Date.now();
        const ctx = this._extractContext(event);
        const ctxTime = Date.now() - ctxStart;
        if (!ctx.userId) {
            return;
        }
        
        // 🔍 诊断日志：记录消息处理开始
        const eventId = event.id || event.message?.id || event.queryId || 'unknown';
        const version = appVersion;
        
        log.info(`🔍 [MSG_DEDUP] 消息处理开始 - EventID: ${eventId}, UserID: ${ctx.userId}, Instance: ${instanceCoordinator.getInstanceId()}, Version: ${version}`);
        
        // 🔍 诊断日志：检查锁状态
        try {
            const hasLock = await instanceCoordinator.hasLock('telegram_client');
            log.info(`🔍 [MSG_DEDUP] 锁状态检查 - EventID: ${eventId}, HasLock: ${hasLock}, Instance: ${instanceCoordinator.getInstanceId()}`);
        } catch (e) {
            log.warn(`🔍 [MSG_DEDUP] 锁状态检查失败 - EventID: ${eventId}, Error: ${e.message}`);
        }

        // 2. 全局前置守卫 (权限、维护模式)
        const guardStart = Date.now();
        const passed = await this._globalGuard(event, ctx);
        const guardTime = Date.now() - guardStart;
        if (!passed) {
            logPerf().info(`消息被全局守卫拦截 (User: ${ctx.userId}, guard: ${guardTime}ms, total: ${Date.now() - start}ms)`);
            return;
        }

        // 3. 路由分发
        // 使用 className 检查替代 instanceof，提高鲁棒性并方便测试
        if (event.className === 'UpdateBotCallbackQuery') {
            logPerf().info(`回调处理开始 (User: ${ctx.userId}, ctx: ${ctxTime}ms, guard: ${guardTime}ms)`);
            await this._handleCallback(event, ctx);
        } else if (event.className === 'UpdateNewMessage' && event.message) {
            logPerf().info(`消息处理开始 (User: ${ctx.userId}, ctx: ${ctxTime}ms, guard: ${guardTime}ms)`);
            await this._handleMessage(event, ctx);
        }
        
        logPerf().info(`总耗时 ${Date.now() - start}ms`);
    }

    /**
     * [私有] 提取上下文 (User ID, Chat ID 等)
     */
    static _extractContext(event) {
        let userId = null;
        let target = null;
        let isCallback = false;

        try {
            if (event.className === 'UpdateBotCallbackQuery') {
                userId = event.userId?.toString();
                target = event.peer;
                isCallback = true;
            } else if (event.className === 'UpdateNewMessage' && event.message) {
                const m = event.message;
                // 兼容不同版本的 GramJS 消息结构
                const fromId = m.fromId;
                if (fromId) {
                    if (fromId.userId) userId = fromId.userId.toString();
                    else if (fromId.chatId) userId = fromId.chatId.toString();
                }
                
                if (!userId && m.senderId) {
                    userId = m.senderId.toString();
                }
                
                target = m.peerId;
            }
        } catch (e) {
            log.error(`Context extraction error:`, e);
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

        // 1. 黑名单拦截 (最高优先级，连 Owner 也不能例外，防止账号被盗后的紧急风控，虽然 owner 很难被 setRole 修改)
        if (role === 'banned') {
            logPerf().info(`消息被黑名单拦截 (User: ${userId})`);
            return false; 
        }

        if (!isOwner && !(await AuthGuard.can(userId, "maintenance:bypass"))) {
            if (mode !== 'public') {
                const text = STRINGS.system.maintenance_mode;
                if (isCallback) {
                    await runBotTaskWithRetry(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
                        queryId: event.queryId,
                        message: STRINGS.system.maintenance_alert,
                        alert: true
                    })).catch((error) => {
                        log.warn('Failed to send maintenance alert callback', {
                            userId,
                            error: error.message
                        });
                    }), userId, {}, false, 3);
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
        })).catch((error) => {
            log.warn('Failed to send callback answer', {
                userId,
                queryId: event.queryId,
                error: error.message
            });
        }), userId, {}, false, 3);

        if (data === "noop") return await answer();

        if (data.startsWith("cancel_msg_")) {
            const msgId = data.split("_")[2];
            const ok = await TaskManager.cancelTasksByMsgId(msgId, userId);
            await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);

        } else if (data.startsWith("cancel_batch_")) {
            // 兼容历史按钮：旧版使用 groupedId，无法从 DB 反查任务（会导致“点了没反应”）
            await answer(STRINGS.task.task_not_found);

        } else if (data.startsWith("cancel_")) {
            const taskId = data.split("_")[1];
            const ok = await TaskManager.cancelTask(taskId, userId);
            await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);
        
        } else if (data.startsWith("drive_")) { 
            const toast = await DriveConfigFlow.handleCallback(event, userId);
            await answer(toast || "");
        
        } else if (data === "diagnosis_run") {
            await this._handleDiagnosisCommand(event.peer, userId);
            return await answer();

        } else if (data.startsWith("files_")) {
            await this._handleFilesCallback(event, data, userId, answer);

        } else if (data.startsWith("remote_folder_")) {
            await this._handleRemoteFolderCallback(event, userId, answer);

        } else {
            log.warn(`未知回调数据: ${data}`, { userId, eventId: event.id?.toString() });
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
            await this._waitForFilesRefreshDelay();
            
            const files = await CloudTool.listRemoteFiles(userId, isRefresh);
            const { text, buttons } = await UIHelper.renderFilesPage(files, page, 6, CloudTool.isLoading(), userId);
            await safeEdit(event.userId, event.msgId, text, buttons, userId);
        }
        await answerCallback(isRefresh ? STRINGS.files.refresh_success : "");
    }

    /**
     * [私有] 在刷新线程中加入延迟以防抖（测试环境下会跳过）
     */
    static async _waitForFilesRefreshDelay() {
        if (FILES_REFRESH_DELAY_MS <= 0) return;
        await new Promise((resolve) => setTimeout(resolve, FILES_REFRESH_DELAY_MS));
    }

    /**
     * [私有] 处理普通消息
     */
    /**
     * [私有] 处理 /start 命令的快速路径
     * @returns {Promise<boolean>} 是否已处理
     */
    static async _handleStartCommandFastPath(target, userId, text) {
        if (text !== "/start") return false;

        const [mode, canBypass] = await Promise.all([
            SettingsRepository.get("access_mode", "public"),
            AuthGuard.can(userId, "maintenance:bypass")
        ]);
        const isOwner = userId === config.ownerId?.toString();

        if (!isOwner && mode !== 'public' && !canBypass) {
            await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.system.maintenance_mode,
                parseMode: "html"
            }), userId, {}, false, 3);
            return true;
        }

        await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: STRINGS.system.welcome,
            parseMode: "html"
        }), userId, {}, false, 3);
        return true;
    }

    /**
     * [私有] 处理活跃会话拦截
     * @returns {Promise<boolean>} 是否已处理
     */
    static async _handleActiveSession(event, userId) {
        const session = await SessionManager.get(userId);
        if (session) {
            const handled = await DriveConfigFlow.handleInput(event, userId, session);
            if (handled) return true;
            // 处理 remote_folder 会话输入
            const remoteFolderHandled = await this._handleRemoteFolderInput(event, userId, session);
            if (remoteFolderHandled) return true;
        }
        return false;
    }

    /**
     * [私有] 获取用户默认或回退的驱动器
     */
    static async _getDefaultDrive(userId) {
        const [defaultDriveId, drives] = await Promise.all([
            SettingsRepository.get(`default_drive_${userId}`, null),
            DriveRepository.findByUserId(userId)
        ]);

        let finalSelectedDrive = null;
        if (drives && drives.length > 0) {
            finalSelectedDrive = drives.find(d => d.id === defaultDriveId) || drives[0];
        }
        
        if (!finalSelectedDrive) {
            const fallbackDrives = await DriveRepository.findByUserId(userId, true);
            if (fallbackDrives && fallbackDrives.length > 0) {
                finalSelectedDrive = fallbackDrives[0];
            }
        }
        return finalSelectedDrive;
    }

    /**
     * [私有] 处理文本命令路由
     * @returns {Promise<boolean>} 是否已处理
     */
    static async _routeTextCommand(target, userId, text, message, finalSelectedDrive) {
        if (!text || message.media) return false;

        const command = text.split(' ')[0]; // 只匹配第一段，如 /drive

        // 🛡️ 统一权限拦截 (RBAC Middleware)
        const requiredPerm = COMMAND_PERMISSIONS[command];
        if (requiredPerm) {
            // Owner 永远有权限，跳过检查 (虽然 AuthGuard.can 也会放行 owner，但这里显式一点)
            const isOwner = userId === config.ownerId?.toString();
            if (!isOwner && !(await AuthGuard.can(userId, requiredPerm))) {
                await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: STRINGS.status.no_permission || "❌ 您没有权限执行此操作。",
                    parseMode: "html"
                }), userId, {}, false, 3);
                return true;
            }
        }

        switch (command) {
            case "/drive":
                await DriveConfigFlow.sendDriveManager(target, userId); return true;
            case "/logout":
            case "/unbind":
                await DriveConfigFlow.handleUnbind(target, userId); return true;
            case "/files":
                await this._handleFilesCommand(target, userId); return true;
            case "/status":
                await this._handleStatusCommand(target, userId, text); return true;
            case "/help":
                await this._handleHelpCommand(target, userId); return true;
            case "/mcp":
                await this._handleMcpCommand(target, userId); return true;
            case "/mcp_token":
                await this._handleMcpTokenCommand(target, userId); return true;
            case "/diagnosis":
                await this._handleDiagnosisCommand(target, userId); return true;
            case "/open_service":
                await this._handleModeSwitchCommand(target, userId, 'public'); return true;
            case "/close_service":
                await this._handleModeSwitchCommand(target, userId, 'private'); return true;
            case "/status_public":
                await this._handleModeSwitchCommand(target, userId, 'public'); return true;
            case "/status_private":
                await this._handleModeSwitchCommand(target, userId, 'private'); return true;
            case "/pro_admin":
                await this._handleAdminPromotion(target, userId, text, true); return true;
            case "/de_admin":
                await this._handleAdminPromotion(target, userId, text, false); return true;
            case "/ban":
                await this._handleBanCommand(target, userId, text, true); return true;
            case "/unban":
                await this._handleBanCommand(target, userId, text, false); return true;
            case "/remote_folder":
                await this._handleRemoteFolderCommand(target, userId); return true;
            case "/set_remote_folder":
                await this._handleSetRemoteFolderCommand(target, userId, text); return true;
        }

        return false;
    }

    /**
     * [私有] 处理链接解析
     * @returns {Promise<boolean>} 是否已处理
     */
    static async _handleLinks(target, userId, text, finalSelectedDrive) {
        if (!text) return false;

        try {
            const toProcess = await LinkParser.parse(text, userId);
            if (toProcess && toProcess.length > 0) {
                if (!finalSelectedDrive) {
                    await this._sendBindHint(target, userId);
                    return true;
                }

                if (toProcess.length > 10) await runBotTaskWithRetry(() => client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` }), userId, {}, false, 3);
                for (const msg of toProcess.slice(0, 10)) await TaskManager.addTask(target, msg, userId, "链接");
                return true;
            }
        } catch (e) {
            await runBotTaskWithRetry(() => client.sendMessage(target, { message: `❌ ${escapeHTML(e.message)}`, parseMode: "html" }), userId, {}, false, 3);
            return true;
        }
        return false;
    }

    /**
     * [私有] 处理媒体消息
     * @returns {Promise<boolean>} 是否已处理
     */
    static async _handleMediaMessage(target, userId, message, finalSelectedDrive) {
        if (!message.media) return false;

        if (!finalSelectedDrive) {
            await this._sendBindHint(target, userId);
            return true;
        }

        // 🚀 核心逻辑：如果是媒体组消息
        if (message.groupedId) {
            // 使用新的 MediaGroupBuffer 服务
            try {
                const result = await mediaGroupBuffer.add(message, target, userId);
                if (!result.added && result.reason !== 'duplicate') {
                    log.warn(`Failed to add message to buffer: ${result.reason}`);
                }
            } catch (error) {
                log.error('MediaGroupBuffer.add failed, falling back to single task', { error: error?.message });
                await TaskManager.addTask(target, message, userId, "媒体组(降级)");
            }
            return true;
        }

        // 零散文件逻辑保持不动
        await TaskManager.addTask(target, message, userId, "文件");
        return true;
    }

    /**
     * [私有] 处理普通消息
     */
    static async _handleMessage(event, { userId, target }) {
        const message = event.message;
        const text = message.message;

        // 🚀 性能优化：为 /start 命令添加快速路径
        if (await this._handleStartCommandFastPath(target, userId, text)) return;

        // 1. 会话拦截 (密码输入等)
        if (await this._handleActiveSession(event, userId)) return;

        const finalSelectedDrive = await this._getDefaultDrive(userId);

        // 2. 文本命令路由
        if (text && !message.media) {
            if (await this._routeTextCommand(target, userId, text, message, finalSelectedDrive)) return;

            // 3. 尝试解析链接
            if (await this._handleLinks(target, userId, text, finalSelectedDrive)) return;

            // 4. 通用兜底回复：纯文本消息（包括未匹配的命令）
            return await runBotTaskWithRetry(() => client.sendMessage(target, { 
                message: STRINGS.system.welcome,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        // 5. 处理带媒体的消息 (文件/视频/图片)
        if (await this._handleMediaMessage(target, userId, message, finalSelectedDrive)) return;
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
                let drives = await DriveRepository.findByUserId(userId);
                if (!drives || drives.length === 0) {
                    drives = await DriveRepository.findByUserId(userId, true);
                }
                if (!drives || drives.length === 0) {
                    await safeEdit(target, placeholder.id, STRINGS.drive.no_drive_found, null, userId);
                    return;
                }
                const drive = drives[0];

                // 如果 listRemoteFiles 命中了 Redis 或内存缓存，这里会非常快
                const files = await CloudTool.listRemoteFiles(userId);
                const { text, buttons } = await UIHelper.renderFilesPage(files, 0, 6, CloudTool.isLoading(), userId);
                await safeEdit(target, placeholder.id, text, buttons, userId);

                // 如果发现数据是加载中的（例如缓存过期正在后台刷新），可以考虑在这里逻辑
            } catch (e) {
                log.error("Files command async error:", e);
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
                const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
                if (isAdmin) {
                    buttons = [
                        [Button.inline(STRINGS.status.btn_diagnosis, Buffer.from("diagnosis_run"))]
                    ];
                }
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
        const waitingCount = TaskManager.getWaitingCount();
        const processingCount = TaskManager.getProcessingCount();
        const currentTask = TaskManager.currentTask;
        
        let status = format(STRINGS.status.header, {}) + '\n\n';
        status += format(STRINGS.status.queue_title, {}) + '\n';
        status += format(STRINGS.status.waiting_tasks, { count: waitingCount }) + '\n';
        status += format(STRINGS.status.current_task, { count: processingCount }) + '\n';
        
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
        const drives = await DriveRepository.findByUserId(userId);
        const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
        const activeDrive = drives.length > 0 ? (drives.find(d => d.id === defaultDriveId) || drives[0]) : null;

        const waitingCount = TaskManager.getWaitingCount();
        const processingCount = TaskManager.getProcessingCount();
        
        let status = format(STRINGS.status.header, {}) + '\n\n';
        
        // 网盘状态
        const driveType = activeDrive?.type ? activeDrive.type.toUpperCase() : '未知';
        status += format(STRINGS.status.drive_status, {
            status: activeDrive ? `✅ 已绑定 (${driveType})` : '❌ 未绑定'
        }) + '\n\n';
        
        // 队列状态
        status += format(STRINGS.status.queue_title, {}) + '\n';
        status += format(STRINGS.status.waiting_tasks, { count: waitingCount }) + '\n';
        status += format(STRINGS.status.current_task, { count: processingCount }) + '\n';
        
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
     * [私有] 处理 /mcp_token 命令
     */
    static async _handleMcpTokenCommand(target, userId) {
        try {
            const token = await ApiKeyRepository.getOrCreateToken(userId);
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: format(STRINGS.system.mcp_token, { token }),
                parseMode: "html"
            }), userId, {}, false, 3);
        } catch (error) {
            log.error("Failed to handle /mcp_token:", error);
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: "❌ 令牌获取失败，请稍后重试。"
            }), userId, {}, false, 3);
        }
    }

    /**
     * [私有] 处理 /mcp 命令
     */
    static async _handleMcpCommand(target, userId) {
        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: STRINGS.system.mcp_help,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 处理 /help 命令
     */
    static async _handleHelpCommand(target, userId) {
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
        const isOwner = userId === config.ownerId?.toString();
        const version = appVersion;

        let message = format(STRINGS.system.help, { version });

        if (!isAdmin) {
            // 移除管理员命令部分
            const parts = message.split("<b>管理员命令：</b>");
            if (parts.length > 1) {
                message = parts[0] + "如有疑问或建议，请联系管理员。";
            }
        } else if (!isOwner) {
            // 如果是普通管理员，移除只有 Owner 才能用的命令
            message = message.replace("/pro_admin - 👑 设置管理员 (UID)\n", "");
            message = message.replace("/de_admin - 🗑️ 取消管理员 (UID)\n", "");
        }

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

    /**
     * [私有] 处理 /diagnosis 命令 (管理员专用)
     */
    static async _handleDiagnosisCommand(target, userId) {
        // 检查管理员权限
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
        if (!isAdmin) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: "❌ 此命令仅限管理员使用。",
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        // 发送占位消息
        const placeholder = await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: "🔍 正在执行系统诊断..."
        }), userId, {}, false, 3);

        // 异步执行诊断
        (async () => {
            try {
                // 并行执行网络诊断和实例状态获取
                const [networkResults, instanceInfo] = await Promise.all([
                    NetworkDiagnostic.diagnoseAll(),
                    this._getInstanceInfo()
                ]);

                // 获取系统资源信息
                const memUsage = process.memoryUsage();
                const rss = Math.round(memUsage.rss / 1024 / 1024);
                const heapUsed = Math.round(memUsage.heapUsed / 1024 / 1024);
                const heapTotal = Math.round(memUsage.heapTotal / 1024 / 1024);

                const systemResources = {
                    memoryMB: `${rss}MB (${heapUsed}MB/${heapTotal}MB)`,
                    uptime: this._getUptime()
                };

                // 使用 UIHelper 渲染诊断报告
                const message = UIHelper.renderDiagnosisReport({
                    networkResults,
                    instanceInfo,
                    systemResources
                });

                await safeEdit(target, placeholder.id, message, null, userId);
            } catch (error) {
                log.error("Diagnosis error:", error);
                await safeEdit(target, placeholder.id, `❌ 诊断过程中发生错误: ${escapeHTML(error.message)}`, null, userId);
            }
        })();
    }

    /**
     * [私有] 获取多实例状态信息 (返回结构化对象)
     */
    static async _getInstanceInfo() {
        const instanceInfo = {};
        instanceInfo.version = appVersion;

        try {
            // 当前实例信息
            instanceInfo.currentInstanceId = instanceCoordinator.getInstanceId();
            instanceInfo.isLeader = instanceCoordinator.isLeader;
            instanceInfo.cacheProvider = cache.getCurrentProvider?.() || cache.getProviderName?.() || "unknown";
            instanceInfo.cacheFailover = !!cache.isFailoverMode;

            // Telegram 状态
            instanceInfo.tgActive = isClientActive();
            instanceInfo.isTgLeader = await instanceCoordinator.hasLock('telegram_client');

            // 活跃实例信息
            instanceInfo.activeInstances = await instanceCoordinator.getActiveInstances();
            instanceInfo.instanceCount = await instanceCoordinator.getInstanceCount();

        } catch (error) {
            log.error("获取实例信息失败:", error);
            instanceInfo.error = error.message;
        }

        return instanceInfo;
    }

    /**
     * [私有] 处理模式切换命令 (/status_public, /status_private)
     */
    static async _handleModeSwitchCommand(target, userId, mode) {
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
        if (!isAdmin) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        await SettingsRepository.set("access_mode", mode);

        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: format(STRINGS.status.mode_changed, { mode: mode === 'public' ? '公开' : '私有(维护)' }),
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 处理管理员设置命令 (/pro_admin, /de_admin)
     */
    static async _handleAdminPromotion(target, userId, fullText, isPromotion) {
        const isOwner = userId === config.ownerId?.toString();
        if (!isOwner) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const parts = fullText.split(' ');
        if (parts.length < 2) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: `❌ 请提供 UID。用法: <code>${parts[0]} [UID]</code>`,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const targetUid = parts[1].trim();
        try {
            if (isPromotion) {
                await AuthGuard.setRole(targetUid, 'admin');
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: `✅ 已将用户 <code>${targetUid}</code> 设置为管理员。`,
                    parseMode: "html"
                }), userId, {}, false, 3);
            } else {
                await AuthGuard.removeRole(targetUid);
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: `✅ 已取消用户 <code>${targetUid}</code> 的管理员权限。`,
                    parseMode: "html"
                }), userId, {}, false, 3);
            }
        } catch (error) {
            log.error("Failed to update user role:", error);
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: "❌ 数据库操作失败，请检查 UID 是否正确。",
                parseMode: "html"
            }), userId, {}, false, 3);
        }
    }

    /**
     * [私有] 处理管理员封禁/解封命令 (/ban, /unban)
     */
    static async _handleBanCommand(target, userId, fullText, isBan) {
        // 权限检查已在中间件完成，这里直接执行逻辑
        const parts = fullText.split(' ');
        if (parts.length < 2) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: `❌ 请提供 UID。用法: <code>${parts[0]} [UID]</code>`,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const targetUid = parts[1].trim();
        
        // 防止封禁自己或 Owner
        if (isBan) {
            if (targetUid === userId) {
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: "❌ 不能封禁自己。",
                    parseMode: "html"
                }), userId, {}, false, 3);
            }
            if (targetUid === config.ownerId?.toString()) {
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: "❌ 不能封禁 Owner。",
                    parseMode: "html"
                }), userId, {}, false, 3);
            }
        }

        try {
            if (isBan) {
                await AuthGuard.setRole(targetUid, 'banned');
                // 立即清理该用户的会话
                await SessionManager.clear(targetUid);
                // 可以考虑清理该用户的网盘绑定 (可选，暂时不清理，解封后还能用)
                
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: `🚫 已封禁用户 <code>${targetUid}</code>。`,
                    parseMode: "html"
                }), userId, {}, false, 3);
            } else {
                // 解封恢复为默认角色 'user'
                await AuthGuard.setRole(targetUid, 'user');
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: `✅ 已解封用户 <code>${targetUid}</code> (重置为 user)。`,
                    parseMode: "html"
                }), userId, {}, false, 3);
            }
        } catch (error) {
            log.error("Failed to update user ban status:", error);
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: "❌ 数据库操作失败，请检查 UID 是否正确。",
                parseMode: "html"
            }), userId, {}, false, 3);
        }
    }

    /**
     * [私有] 处理 /remote_folder 命令 - 显示上传路径设置菜单
     * @param {Object} target - 消息目标
     * @param {string} userId - 用户ID
     */
    static async _handleRemoteFolderCommand(target, userId) {
        // 检查是否已绑定网盘
        let drives = await DriveRepository.findByUserId(userId);
        if (!drives || drives.length === 0) {
            drives = await DriveRepository.findByUserId(userId, true);
        }
        if (!drives || drives.length === 0) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.remote_folder.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        // 获取当前路径
        const currentPath = await this._getUserUploadPathFromD1(userId);
        const displayPath = currentPath || config.remoteFolder;
        const isCustomPath = !!currentPath;

        let message = format(STRINGS.remote_folder.menu_title, {});
        const pathInfo = displayPath + (isCustomPath ? " (自定义)" : " (默认)");
        message += format(STRINGS.remote_folder.show_current, { path: pathInfo });

        const buttons = [
            [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))],
            [Button.inline(STRINGS.remote_folder.btn_reset_path, Buffer.from("remote_folder_reset"))]
        ];

        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: message,
            buttons: buttons,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 处理 /set_remote_folder 命令
     * @param {Object} target - 消息目标
     * @param {string} userId - 用户ID
     * @param {string} fullText - 完整命令文本
     */
    static async _handleSetRemoteFolderCommand(target, userId, fullText) {
        // 检查是否已绑定网盘
        let drives = await DriveRepository.findByUserId(userId);
        if (!drives || drives.length === 0) {
            drives = await DriveRepository.findByUserId(userId, true);
        }
        if (!drives || drives.length === 0) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.remote_folder.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        // 解析命令参数
        const parts = fullText.split(' ');
        const pathArg = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';

        try {
            // 情况1: 无参数 - 启动交互式设置流程
            if (!pathArg) {
                await SessionManager.start(userId, "REMOTE_FOLDER_WAIT_PATH");
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: STRINGS.remote_folder.input_prompt,
                    parseMode: "html"
                }), userId, {}, false, 3);
            }

            // 情况2: 重置为默认路径
            if (pathArg === 'reset' || pathArg === 'default') {
                await this._setUserUploadPathInD1(userId, null);
                
                const defaultPath = config.remoteFolder;
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: format(STRINGS.remote_folder.reset_success, { 
                        path: defaultPath,
                        description: "系统默认路径"
                    }),
                    parseMode: "html"
                }), userId, {}, false, 3);
            }

            // 情况3: 设置新路径
            if (!CloudTool._validatePath(pathArg)) {
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: STRINGS.remote_folder.invalid_path,
                    parseMode: "html"
                }), userId, {}, false, 3);
            }

            await this._setUserUploadPathInD1(userId, pathArg);

            // 清除该用户的文件缓存
            const cacheKey = `files_${userId}`;
            localCache.del(cacheKey);
            try {
                await cache.delete(cacheKey);
            } catch (e) {
                log.warn(`Failed to clear cache for user ${userId}:`, e.message);
            }

            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: format(STRINGS.remote_folder.set_success, { path: pathArg }),
                parseMode: "html"
            }), userId, {}, false, 3);

        } catch (error) {
            log.error(`Error handling /set_remote_folder for user ${userId}:`, error);
            
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.remote_folder.error_saving,
                parseMode: "html"
            }), userId, {}, false, 3);
        }
    }

    /**
     * [私有] 处理远程文件夹设置的会话输入
     * @param {Object} event - Telegram 事件对象
     * @param {string} userId - 用户ID
     * @param {Object} session - 当前会话状态
     * @returns {Promise<boolean>} 是否拦截了消息
     */
    static async _handleRemoteFolderInput(event, userId, session) {
        const text = event.message.message.trim();
        const peerId = event.message.peerId;

        if (session.current_step === "REMOTE_FOLDER_WAIT_PATH") {
            // 验证路径格式
            if (!CloudTool._validatePath(text)) {
                await runBotTaskWithRetry(() => client.sendMessage(peerId, {
                    message: STRINGS.remote_folder.invalid_path,
                    parseMode: "html"
                }), userId, {}, false, 3);
                return true;
            }

            try {
                await this._setUserUploadPathInD1(userId, text);

                // 清除缓存
                const cacheKey = `files_${userId}`;
                localCache.del(cacheKey);
                try {
                    await cache.delete(cacheKey);
                } catch (e) {
                    log.warn(`Failed to clear cache for user ${userId}:`, e.message);
                }

                await SessionManager.clear(userId);
                await runBotTaskWithRetry(() => client.sendMessage(peerId, {
                    message: format(STRINGS.remote_folder.set_success, { path: text }),
                    parseMode: "html"
                }), userId, {}, false, 3);
            } catch (error) {
                log.error(`Error saving remote folder for user ${userId}:`, error);
                await SessionManager.clear(userId);
                await runBotTaskWithRetry(() => client.sendMessage(peerId, {
                    message: STRINGS.remote_folder.error_saving,
                    parseMode: "html"
                }), userId, {}, false, 3);
            }
            return true;
        }

        return false;
    }

    /**
     * 从D1数据库获取用户上传路径
     * @param {string} userId - 用户ID
     * @returns {Promise<string|null>} 用户自定义路径或null
     */
    static async _getUserUploadPathFromD1(userId) {
        try {
            const drives = await DriveRepository.findByUserId(userId);
            const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
            const activeDrive = drives.length > 0 ? (drives.find(d => d.id === defaultDriveId) || drives[0]) : null;
            
            if (activeDrive && activeDrive.remote_folder) {
                return activeDrive.remote_folder;
            }
            
            return null;
        } catch (error) {
            log.error(`Failed to query upload path from D1 for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * 设置用户上传路径到D1数据库
     * @param {string} userId - 用户ID
     * @param {string|null} path - 上传路径，null表示重置为默认
     * @returns {Promise<void>}
     */
    static async _setUserUploadPathInD1(userId, path) {
        try {
            const drives = await DriveRepository.findByUserId(userId);
            const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
            const activeDrive = drives.length > 0 ? (drives.find(d => d.id === defaultDriveId) || drives[0]) : null;
            
            if (!activeDrive) {
                throw new Error('Drive not found');
            }
            
            // 更新drives表的remote_folder字段，传递userId用于清理缓存
            await DriveRepository.updateRemoteFolder(activeDrive.id, path, userId);
            
        } catch (error) {
            log.error(`Failed to set upload path in D1 for user ${userId}:`, error);
            throw error;
        }
    }

    /**
     * [私有] 处理 remote_folder 菜单的回调按钮
     * @param {Object} event - Telegram 事件对象
     * @param {string} userId - 用户ID
     * @param {Function} answerCallback - 回调回答函数
     */
    static async _handleRemoteFolderCallback(event, userId, answerCallback) {
        const data = event.data.toString();

        if (data === "remote_folder_set") {
            await SessionManager.start(userId, "REMOTE_FOLDER_WAIT_PATH");
            await safeEdit(event.userId, event.msgId, STRINGS.remote_folder.input_prompt, null, userId);
            await answerCallback("");
        } else if (data === "remote_folder_reset") {
            await this._setUserUploadPathInD1(userId, null);
            await safeEdit(event.userId, event.msgId, format(STRINGS.remote_folder.reset_success, { path: config.remoteFolder }), null, userId);
            await answerCallback("");
        } else {
            await answerCallback("");
        }
    }
}
