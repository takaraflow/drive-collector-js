import { Api } from "telegram";
import { Button } from "telegram/tl/custom/button.js";
import { getConfig } from "../config/index.js";
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
import { TaskRepository } from "../repositories/TaskRepository.js";
import { ApiKeyRepository } from "../repositories/ApiKeyRepository.js";
import { safeEdit, escapeHTML } from "../utils/common.js";
import { parseDriveSessionData } from "../domain/drive-session-step.js";
import { runBotTask, runBotTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { NetworkDiagnostic } from "../utils/NetworkDiagnostic.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { cache } from "../services/CacheService.js";
import { queueService } from "../services/QueueService.js";
import { logger } from "../services/logger/index.js";
import { localCache } from "../utils/LocalCache.js";
import mediaGroupBuffer from "../services/MediaGroupBuffer.js";
import { TASK_STATUSES } from "../domain/task-state-machine.js";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const log = logger.withModule('Dispatcher');
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const appVersion = packageJson.version || 'unknown';
const getOwnerId = () => getConfig().ownerId?.toString();
const getDefaultRemoteFolder = () => getConfig().remoteFolder;
const getNodeEnv = () => getConfig().nodeEnv;
const getFilesRefreshDelayMs = () => getNodeEnv() === 'test' ? 0 : 50;

// 创建带 perf 上下文的 logger 用于性能日志
const logPerf = () => log.withContext({ perf: true });
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
    "/task_queue":        "system:admin",

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

    // 防止同一用户/消息的刷新按钮被疯狂点击
    static filesRefreshTimes = new Map();

    static _getWelcomeButtons() {
        return [
            [
                Button.inline(STRINGS.system.btn_bind_drive, Buffer.from("drive_select_type")),
                Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))
            ],
            [
                Button.inline(STRINGS.status.btn_my_status, Buffer.from("status_general")),
                Button.inline(STRINGS.system.btn_help, Buffer.from("help_main"))
            ]
        ];
    }

    static _getNoDriveButtons() {
        return [
            [Button.inline(STRINGS.system.btn_bind_drive, Buffer.from("drive_select_type"))],
            [Button.inline(STRINGS.system.btn_help, Buffer.from("help_main"))]
        ];
    }

    static _getHelpButtons(isAdmin = false) {
        const buttons = [
            [
                Button.inline(STRINGS.system.btn_bind_drive, Buffer.from("drive_select_type")),
                Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))
            ],
            [
                Button.inline(STRINGS.status.btn_my_status, Buffer.from("status_general")),
                Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_menu"))
            ]
        ];

        if (isAdmin) {
            buttons.push([
                Button.inline(STRINGS.status.btn_task_queue, Buffer.from("task_queue_open")),
                Button.inline(STRINGS.status.btn_diagnosis, Buffer.from("diagnosis_run"))
            ]);
        }

        return buttons;
    }

    static _getStatusButtons(isAdmin = false) {
        const buttons = [
            [
                Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0")),
                Button.inline(STRINGS.system.btn_help, Buffer.from("help_main"))
            ]
        ];

        if (isAdmin) {
            buttons.unshift([
                Button.inline(STRINGS.status.btn_task_queue, Buffer.from("task_queue_open")),
                Button.inline(STRINGS.status.btn_diagnosis, Buffer.from("diagnosis_run"))
            ]);
        }

        return buttons;
    }

    static _getPersonalStatusButtons(queueOverview, isAdmin = false) {
        const buttons = [];
        const activeTask = queueOverview?.activeTasks?.find(task => task?.id);
        const failedTask = queueOverview?.recentTasks?.find(task => task?.id && task.status === TASK_STATUSES.FAILED);

        if (activeTask) {
            buttons.push([
                Button.inline(`🚫 ${STRINGS.task.btn_cancel_active}`, Buffer.from(`cancel_confirm_${activeTask.id}`))
            ]);
        }

        if (failedTask) {
            buttons.push([
                Button.inline(`🔄 ${STRINGS.task.btn_retry_failed}`, Buffer.from(`retry_confirm_${failedTask.id}`))
            ]);
        }

        buttons.push([
            Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0")),
            Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_menu"))
        ]);

        if (isAdmin) {
            buttons.push([
                Button.inline(STRINGS.status.btn_task_queue, Buffer.from("task_queue_open")),
                Button.inline(STRINGS.status.btn_diagnosis, Buffer.from("diagnosis_run"))
            ]);
        }

        return buttons;
    }

    static _getFilesRecoveryButtons(page = 0) {
        return [
            [Button.inline(STRINGS.files.btn_retry_load, Buffer.from(`files_refresh_${page}`))],
            [Button.inline(STRINGS.system.btn_help, Buffer.from("help_main"))]
        ];
    }

    static _getRemoteFolderInputButtons() {
        return [
            [Button.inline(STRINGS.remote_folder.btn_cancel, Buffer.from("remote_folder_cancel"))]
        ];
    }

    static _getTaskActionConfirmButtons(confirmData) {
        return [
            [Button.inline(STRINGS.task.btn_keep_task, Buffer.from("task_action_back"))],
            [Button.inline(
                confirmData.startsWith("retry_execute_") ? STRINGS.task.btn_confirm_retry : STRINGS.task.btn_confirm_cancel,
                Buffer.from(confirmData)
            )]
        ];
    }

    static _getAdminActionConfirmButtons(nonce) {
        return [
            [Button.inline(STRINGS.status.btn_cancel_action, Buffer.from(`admin_action_cancel_${nonce}`))],
            [Button.inline(STRINGS.status.btn_confirm_action, Buffer.from(`admin_action_execute_${nonce}`))]
        ];
    }

    static async _askAdminActionConfirmation(target, userId, action) {
        const nonce = this._createCallbackNonce();
        await SessionManager.start(userId, "ADMIN_ACTION_CONFIRM", { ...action, nonce });
        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: format(STRINGS.status.action_confirm, {
                action: action.label,
                target: action.target || "服务状态"
            }),
            buttons: this._getAdminActionConfirmButtons(nonce),
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    static _getFailedPageRetryConfirmButtons(nonce) {
        return [
            [Button.inline(STRINGS.task.btn_keep_task, Buffer.from(`retry_failed_page_cancel_${nonce}`))],
            [Button.inline(STRINGS.task.btn_confirm_retry, Buffer.from(`retry_failed_page_execute_${nonce}`))]
        ];
    }

    static _createCallbackNonce() {
        return randomUUID().replace(/-/g, "").slice(0, 12);
    }

    static _getCommandArg(fullText) {
        return fullText.split(/\s+/).slice(1).join(" ").trim();
    }

    static async _sendAdminUsage(target, userId, command) {
        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: format(STRINGS.status.user_id_required, { command }),
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    static async _sendAdminError(target, userId, message) {
        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    static async _executeAdminAction(userId, action) {
        if (!action?.type) {
            return STRINGS.task.task_not_found;
        }

        try {
            if (action.type === "access_mode") {
                const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
                if (!isAdmin) return STRINGS.status.no_permission;

                const mode = action.mode === "private" ? "private" : "public";
                await SettingsRepository.set("access_mode", mode);
                return format(STRINGS.status.mode_changed, {
                    mode: mode === "public" ? "公开" : "私有(维护)"
                });
            }

            if (action.type === "admin_role") {
                if (userId !== getOwnerId()) return STRINGS.status.no_permission;

                const targetUid = String(action.targetUid || "").trim();
                if (!targetUid) return STRINGS.status.invalid_user_id;

                if (action.operation === "grant") {
                    await AuthGuard.setRole(targetUid, "admin");
                    return format(STRINGS.status.admin_granted, { userId: targetUid });
                }

                await AuthGuard.removeRole(targetUid);
                return format(STRINGS.status.admin_revoked, { userId: targetUid });
            }

            if (action.type === "user_ban") {
                const canManage = await AuthGuard.can(userId, "system:admin");
                if (!canManage) return STRINGS.status.no_permission;

                const targetUid = String(action.targetUid || "").trim();
                if (!targetUid) return STRINGS.status.invalid_user_id;

                if (action.operation === "ban") {
                    if (targetUid === userId) return STRINGS.status.cannot_ban_self;
                    if (targetUid === getOwnerId()) return STRINGS.status.cannot_ban_owner;

                    await AuthGuard.setRole(targetUid, "banned");
                    await SessionManager.clear(targetUid);
                    return format(STRINGS.status.user_banned, { userId: targetUid });
                }

                await AuthGuard.setRole(targetUid, "user");
                return format(STRINGS.status.user_unbanned, { userId: targetUid });
            }

            return STRINGS.task.task_not_found;
        } catch (error) {
            log.error("Admin action execution failed", {
                userId,
                actionType: action.type,
                error: error?.message
            });
            return STRINGS.status.action_failed;
        }
    }

    static _buildHelpPayload(isAdmin = false, isOwner = false) {
        let message = format(STRINGS.system.help, { version: appVersion });
        if (isAdmin) {
            message += STRINGS.system.help_admin;
            if (isOwner) {
                message += STRINGS.system.help_owner;
            }
        }

        return { message, buttons: this._getHelpButtons(isAdmin) };
    }

    static async _buildRemoteFolderMenu(userId) {
        const currentPath = await this._getUserUploadPathFromD1(userId);
        const displayPath = currentPath || getDefaultRemoteFolder();
        const isCustomPath = !!currentPath;

        let message = format(STRINGS.remote_folder.menu_title, {});
        const pathInfo = displayPath + (isCustomPath ? " (自定义)" : " (默认)");
        message += format(STRINGS.remote_folder.show_current, { path: pathInfo }) + '\n\n';
        message += STRINGS.remote_folder.menu_hint;

        const buttons = [
            [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))],
            [Button.inline(STRINGS.remote_folder.btn_reset_path, Buffer.from("remote_folder_reset_confirm"))],
            [Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))]
        ];

        return { message, buttons };
    }

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
        
        log.debug(`🔍 [MSG_DEDUP] 消息处理开始 - EventID: ${eventId}, UserID: ${ctx.userId}, Instance: ${instanceCoordinator.getInstanceId()}, Version: ${version}`);
        
        // 🔍 诊断日志：检查锁状态
        try {
            const hasLock = await instanceCoordinator.hasLock('telegram_client', { logContention: false });
            log.debug(`🔍 [MSG_DEDUP] 锁状态检查 - EventID: ${eventId}, HasLock: ${hasLock}, Instance: ${instanceCoordinator.getInstanceId()}`);
        } catch (e) {
            log.warn(`🔍 [MSG_DEDUP] 锁状态检查失败 - EventID: ${eventId}, Error: ${e.message}`);
        }

        // 2. 全局前置守卫 (权限、维护模式)
        const guardStart = Date.now();
        const passed = await this._globalGuard(event, ctx);
        const guardTime = Date.now() - guardStart;
        if (!passed) {
            logPerf().debug(`消息被全局守卫拦截 (User: ${ctx.userId}, guard: ${guardTime}ms, total: ${Date.now() - start}ms)`);
            return;
        }

        // 3. 路由分发
        // 使用 className 检查替代 instanceof，提高鲁棒性并方便测试
        if (event.className === 'UpdateBotCallbackQuery') {
            logPerf().debug(`回调处理开始 (User: ${ctx.userId}, ctx: ${ctxTime}ms, guard: ${guardTime}ms)`);
            await this._handleCallback(event, ctx);
        } else if (event.className === 'UpdateNewMessage' && event.message) {
            logPerf().debug(`消息处理开始 (User: ${ctx.userId}, ctx: ${ctxTime}ms, guard: ${guardTime}ms)`);
            await this._handleMessage(event, ctx);
        }
        
        logPerf().debug(`总耗时 ${Date.now() - start}ms`);
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

        const isOwner = userId === getOwnerId();

        // 1. 黑名单拦截 (最高优先级，连 Owner 也不能例外，防止账号被盗后的紧急风控，虽然 owner 很难被 setRole 修改)
        if (role === 'banned') {
            logPerf().warn(`消息被黑名单拦截 (User: ${userId})`);
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

        try {
            if (data === "noop") return await answer();

            if (data.startsWith("admin_action_cancel_")) {
                const nonce = data.slice("admin_action_cancel_".length);
                const session = await SessionManager.get(userId);
                const action = session?.current_step === "ADMIN_ACTION_CONFIRM"
                    ? parseDriveSessionData(session)
                    : null;
                if (!action?.nonce || action.nonce !== nonce) {
                    return await answer(STRINGS.task.task_not_found);
                }
                await SessionManager.clear(userId);
                const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
                await safeEdit(event.userId, event.msgId, STRINGS.task.action_cancelled, this._getStatusButtons(isAdmin), userId);
                return await answer(STRINGS.task.action_cancelled);
            }

            if (data.startsWith("admin_action_execute_")) {
                const nonce = data.slice("admin_action_execute_".length);
                const session = await SessionManager.get(userId);
                const action = session?.current_step === "ADMIN_ACTION_CONFIRM"
                    ? parseDriveSessionData(session)
                    : null;
                if (!action?.type) return await answer(STRINGS.task.task_not_found);
                if (action.nonce !== nonce) return await answer(STRINGS.task.task_not_found);
                await SessionManager.clear(userId);
                const message = await this._executeAdminAction(userId, action);
                const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
                await safeEdit(event.userId, event.msgId, message, this._getStatusButtons(isAdmin), userId);
                return await answer();
            }

            if (data === "help_main") {
                const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
                const { message, buttons } = this._buildHelpPayload(isAdmin, userId === getOwnerId());
                await safeEdit(event.userId, event.msgId, message, buttons, userId);
                return await answer();
            }

            if (data === "status_general") {
                const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
                const { message, buttons } = await this._getGeneralStatus(userId, { includeSystemInfo: isAdmin });
                await safeEdit(event.userId, event.msgId, message, buttons, userId);
                return await answer();
            }

            if (data === "task_queue_open") {
                await this._editTaskQueueOverview(event, userId);
                return await answer();
            }

            if (data === "task_action_back") {
                await safeEdit(event.userId, event.msgId, STRINGS.task.action_cancelled, this._getStatusButtons(false), userId);
                await answer(STRINGS.task.action_cancelled);

            } else if (data.startsWith("cancel_msg_confirm_")) {
                const msgId = data.slice("cancel_msg_confirm_".length);
                await safeEdit(event.userId, event.msgId, STRINGS.task.cancel_confirm, this._getTaskActionConfirmButtons(`cancel_msg_execute_${msgId}`), userId);
                await answer();

            } else if (data.startsWith("cancel_msg_execute_")) {
                const msgId = data.slice("cancel_msg_execute_".length);
                const ok = await TaskManager.cancelTasksByMsgId(msgId, userId);
                await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);

            } else if (data.startsWith("cancel_batch_")) {
                // 兼容历史按钮：旧版使用 groupedId，无法从 DB 反查任务（会导致“点了没反应”）
                await answer(STRINGS.task.task_not_found);

            } else if (data.startsWith("cancel_confirm_")) {
                const taskId = data.slice("cancel_confirm_".length);
                await safeEdit(event.userId, event.msgId, STRINGS.task.cancel_confirm, this._getTaskActionConfirmButtons(`cancel_execute_${taskId}`), userId);
                await answer();

            } else if (data.startsWith("cancel_execute_")) {
                const taskId = data.slice("cancel_execute_".length);
                const ok = await TaskManager.cancelTask(taskId, userId);
                await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);

            } else if (data.startsWith("cancel_")) {
                const taskId = data.slice("cancel_".length);
                await safeEdit(event.userId, event.msgId, STRINGS.task.cancel_confirm, this._getTaskActionConfirmButtons(`cancel_execute_${taskId}`), userId);
                await answer();

            } else if (data.startsWith("retry_failed_page_cancel_")) {
                const isAdmin = await AuthGuard.can(userId, "system:admin");
                if (!isAdmin) return await answer(STRINGS.status.no_permission);

                const nonce = data.slice("retry_failed_page_cancel_".length);
                const session = await SessionManager.get(userId);
                const action = session?.current_step === "FAILED_PAGE_RETRY_CONFIRM"
                    ? parseDriveSessionData(session)
                    : null;
                if (action?.nonce === nonce) {
                    await SessionManager.clear(userId);
                }
                await answer(STRINGS.task.action_cancelled);

            } else if (data.startsWith("retry_failed_page_execute_")) {
                const isAdmin = await AuthGuard.can(userId, "system:admin");
                if (!isAdmin) return await answer(STRINGS.status.no_permission);

                const nonce = data.slice("retry_failed_page_execute_".length);
                const session = await SessionManager.get(userId);
                const action = session?.current_step === "FAILED_PAGE_RETRY_CONFIRM"
                    ? parseDriveSessionData(session)
                    : null;
                const taskIds = Array.isArray(action?.taskIds) ? action.taskIds.filter(Boolean) : [];
                if (action?.nonce !== nonce || taskIds.length === 0) return await answer(STRINGS.task.task_not_found);

                await SessionManager.clear(userId);
                const results = await Promise.all(taskIds.map(taskId => TaskManager.retryTask(taskId, userId)));
                const ok = results.some(result => result.success);
                await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);

            } else if (data.startsWith("retry_failed_page_")) {
                const isAdmin = await AuthGuard.can(userId, "system:admin");
                if (!isAdmin) return await answer(STRINGS.status.no_permission);

                const page = Number.parseInt(data.slice("retry_failed_page_".length), 10);
                if (!Number.isInteger(page) || page < 0) {
                    await answer(STRINGS.task.task_not_found);
                } else {
                    const { TaskRepository } = await import("../repositories/TaskRepository.js");
                    const detailData = await TaskRepository.getTasksByStatus("failed", page, 8);
                    const taskIds = detailData.tasks.map(task => task.id).filter(Boolean);
                    if (taskIds.length === 0) {
                        await answer(STRINGS.task.task_not_found);
                    } else {
                        const nonce = this._createCallbackNonce();
                        await SessionManager.start(userId, "FAILED_PAGE_RETRY_CONFIRM", { nonce, taskIds });
                        await safeEdit(event.userId, event.msgId, STRINGS.task.retry_confirm, this._getFailedPageRetryConfirmButtons(nonce), userId);
                        await answer();
                    }
                }

            } else if (data.startsWith("retry_confirm_many_")) {
                // Legacy callback kept for already-rendered short buttons; new page retry uses page-scoped callbacks.
                const taskIds = data.slice("retry_confirm_many_".length);
                const confirmData = `retry_execute_many_${taskIds}`;
                if (Buffer.byteLength(confirmData) > 64) {
                    await answer(STRINGS.task.task_not_found);
                } else {
                    await safeEdit(event.userId, event.msgId, STRINGS.task.retry_confirm, this._getTaskActionConfirmButtons(confirmData), userId);
                    await answer();
                }

            } else if (data.startsWith("retry_execute_many_")) {
                const taskIds = data.slice("retry_execute_many_".length).split(",").filter(Boolean);
                const results = await Promise.all(taskIds.map(taskId => TaskManager.retryTask(taskId, userId)));
                const ok = results.some(result => result.success);
                await answer(ok ? STRINGS.task.cmd_sent : STRINGS.task.task_not_found);

            } else if (data.startsWith("retry_confirm_")) {
                const taskId = data.slice("retry_confirm_".length);
                await safeEdit(event.userId, event.msgId, STRINGS.task.retry_confirm, this._getTaskActionConfirmButtons(`retry_execute_${taskId}`), userId);
                await answer();

            } else if (data.startsWith("retry_execute_")) {
                const taskId = data.slice("retry_execute_".length);
                const result = await TaskManager.retryTask(taskId, userId);
                await answer(result.success ? STRINGS.task.cmd_sent : (result.message || STRINGS.task.task_not_found));

            } else if (data.startsWith("retry_")) {
                const taskId = data.slice("retry_".length);
                await safeEdit(event.userId, event.msgId, STRINGS.task.retry_confirm, this._getTaskActionConfirmButtons(`retry_execute_${taskId}`), userId);
                await answer();

            } else if (data.startsWith("drive_")) {
                const toast = await DriveConfigFlow.handleCallback(event, userId);
                await answer(toast || "");

            } else if (data === "diagnosis_run") {
                await this._editDiagnosisReport(event, userId);
                return await answer();

            } else if (data.startsWith("files_")) {
                await this._handleFilesCallback(event, data, userId, answer);

            } else if (data.startsWith("tq_")) {
                await this._handleTaskQueueCallback(event, data, userId, answer);

            } else if (data.startsWith("remote_folder_")) {
                await this._handleRemoteFolderCallback(event, userId, answer);

            } else {
                log.warn(`未知回调数据: ${data}`, { userId, eventId: event.id?.toString() });
                await answer();
            }
        } catch (error) {
            log.error("Callback handling failed", {
                userId,
                data,
                error: error?.message
            });
            await answer(STRINGS.system.unknown_error);
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
            const refreshKey = `${userId}:${event.msgId || "files"}`;
            const lastRefreshTime = this.filesRefreshTimes.get(refreshKey) || 0;
            if (now - lastRefreshTime < 10000) return await answerCallback(format(STRINGS.files.refresh_limit, {
                seconds: Math.ceil((10000 - (now - lastRefreshTime)) / 1000)
            }));
            this.filesRefreshTimes.set(refreshKey, now);
        }

        if (!isNaN(page)) {
            if (isRefresh) await safeEdit(event.userId, event.msgId, STRINGS.files.syncing, null, userId);
            await this._waitForFilesRefreshDelay();

            try {
                let drives = await DriveRepository.findByUserId(userId);
                if (!drives || drives.length === 0) {
                    drives = await DriveRepository.findByUserId(userId, true);
                }
                if (!drives || drives.length === 0) {
                    await safeEdit(event.userId, event.msgId, STRINGS.drive.no_drive_found, this._getNoDriveButtons(), userId);
                    return await answerCallback();
                }

                const files = await CloudTool.listRemoteFiles(userId, isRefresh);
                const { text, buttons } = await UIHelper.renderFilesPage(files, page, 6, CloudTool.isLoading(), userId);
                await safeEdit(event.userId, event.msgId, text, buttons, userId);
            } catch (error) {
                log.error("Files callback error:", {
                    userId,
                    error: error?.message
                });
                await safeEdit(event.userId, event.msgId, STRINGS.files.load_failed, this._getFilesRecoveryButtons(page), userId);
                return await answerCallback();
            }
        }
        await answerCallback(isRefresh ? STRINGS.files.refresh_success : "");
    }

    /**
     * [私有] 在刷新线程中加入延迟以防抖（测试环境下会跳过）
     */
    static async _waitForFilesRefreshDelay() {
        const delayMs = getFilesRefreshDelayMs();
        if (delayMs <= 0) return;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        const isOwner = userId === getOwnerId();

        if (!isOwner && mode !== 'public' && !canBypass) {
            await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.system.maintenance_mode,
                parseMode: "html"
            }), userId, {}, false, 3);
            return true;
        }

        await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: STRINGS.system.welcome,
            buttons: this._getWelcomeButtons(),
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
        let finalSelectedDrive = await DriveRepository.getDefaultDrive(userId);
        
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
            const isOwner = userId === getOwnerId();
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
            case "/task_queue":
                await this._handleTaskQueueCommand(target, userId); return true;
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
            log.warn("Link parsing failed", {
                userId,
                error: e?.message
            });
            await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.task.link_parse_failed,
                buttons: this._getHelpButtons(false),
                parseMode: "html"
            }), userId, {}, false, 3);
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
                message: STRINGS.system.unknown_input,
                buttons: this._getWelcomeButtons(),
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
                    await safeEdit(target, placeholder.id, STRINGS.drive.no_drive_found, this._getNoDriveButtons(), userId);
                    return;
                }

                // 如果 listRemoteFiles 命中了 Redis 或内存缓存，这里会非常快
                const files = await CloudTool.listRemoteFiles(userId);
                const { text, buttons } = await UIHelper.renderFilesPage(files, 0, 6, CloudTool.isLoading(), userId);
                await safeEdit(target, placeholder.id, text, buttons, userId);

                // 如果发现数据是加载中的（例如缓存过期正在后台刷新），可以考虑在这里逻辑
            } catch (e) {
                log.error("Files command async error:", e);
                await safeEdit(target, placeholder.id, STRINGS.files.load_failed, this._getFilesRecoveryButtons(0), userId);
            }
        })();
    }

    /**
     * [私有] 处理 /status 命令
     */
    static async _handleStatusCommand(target, userId, fullText) {
        const parts = fullText.split(' ');
        const subCommand = parts.length > 1 ? parts[1].toLowerCase() : 'general';
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");

        let message = '';
        let buttons = null;

        switch (subCommand) {
            case 'queue':
                ({ message, buttons } = await this._getQueueStatus(userId, { includeActions: true }));
                break;
            case 'user':
                ({ message, buttons } = await this._getUserStatus(userId, { includeActions: true }));
                break;
            case 'general':
            default:
                ({ message, buttons } = await this._getGeneralStatus(userId, { includeSystemInfo: isAdmin }));
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
    static async _getQueueStatus(userId, { includeActions = false } = {}) {
        const queueOverview = await TaskRepository.getUserQueueOverview(userId, 10);

        let status = format(STRINGS.status.user_header, {}) + '\n\n';
        status += this._renderUserQueueSummary(queueOverview);

        return {
            message: status,
            buttons: includeActions ? this._getPersonalStatusButtons(queueOverview, false) : null
        };
    }

    /**
     * [私有] 获取用户状态
     */
    static async _getUserStatus(userId, { includeActions = false } = {}) {
        const queueOverview = await TaskRepository.getUserQueueOverview(userId, 10);

        let status = format(STRINGS.status.user_header, {}) + '\n\n';
        status += this._renderUserQueueSummary(queueOverview) + '\n';
        status += '\n' + format(STRINGS.status.user_history, {}) + '\n\n';

        const tasks = queueOverview.recentTasks;
        if (!tasks || tasks.length === 0) {
            status += STRINGS.status.no_tasks;
            return {
                message: status,
                buttons: includeActions ? this._getPersonalStatusButtons(queueOverview, false) : null
            };
        }
        
        tasks.forEach((task, index) => {
            status += this._renderStatusTaskItem(task, index) + '\n';
        });
        
        return {
            message: status,
            buttons: includeActions ? this._getPersonalStatusButtons(queueOverview, false) : null
        };
    }

    /**
     * [私有] 获取通用状态
     */
    static async _getGeneralStatus(userId, { includeSystemInfo = false } = {}) {
        const activeDrive = await DriveRepository.getDefaultDrive(userId);
        const queueOverview = await TaskRepository.getUserQueueOverview(userId, 10);
        
        let status = format(includeSystemInfo ? STRINGS.status.admin_header : STRINGS.status.user_header, {}) + '\n\n';
        
        // 网盘状态
        const driveType = activeDrive?.type ? activeDrive.type.toUpperCase() : '未知';
        status += format(STRINGS.status.drive_status, {
            status: activeDrive ? `✅ 已绑定 (${driveType})` : '❌ 未绑定'
        }) + '\n\n';
        
        // 队列状态
        status += this._renderUserQueueSummary(queueOverview) + '\n';
        
        if (includeSystemInfo) {
            status += '\n' + format(STRINGS.status.system_info, {}) + '\n';
            status += format(STRINGS.status.uptime, { uptime: this._getUptime() }) + '\n';
            status += format(STRINGS.status.service_status, { status: '✅ 正常' });
        }
        
        return {
            message: status,
            buttons: this._getPersonalStatusButtons(queueOverview, includeSystemInfo)
        };
    }

    static _renderUserQueueSummary(queueOverview) {
        const queuedCount = queueOverview.statusCounts[TASK_STATUSES.QUEUED] || 0;
        const processingCount = [
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING
        ]
            .reduce((count, status) => count + (queueOverview.statusCounts[status] || 0), 0);

        let status = format(STRINGS.status.queue_title, {}) + '\n';
        status += format(STRINGS.status.waiting_tasks, { count: queuedCount }) + '\n';
        status += format(STRINGS.status.current_task, { count: processingCount }) + '\n';

        if (queueOverview.activeTasks.length === 0) {
            status += STRINGS.status.no_active_tasks + '\n';
            return status;
        }

        status += '\n' + format(STRINGS.status.active_tasks, {}) + '\n';
        queueOverview.activeTasks.forEach((task, index) => {
            status += this._renderStatusTaskItem(task, index) + '\n';
        });

        status += STRINGS.status.active_action_hint + '\n';

        return status;
    }

    static _renderStatusTaskItem(task, index) {
        return format(STRINGS.status.task_item, {
            index: index + 1,
            status: this._getTaskStatusIcon(task.status),
            name: escapeHTML(task.file_name || '未知文件'),
            statusText: this._getTaskStatusText(task.status)
        });
    }

    static _getTaskStatusIcon(status) {
        switch (status) {
            case TASK_STATUSES.COMPLETED:
                return '✅';
            case TASK_STATUSES.FAILED:
                return '❌';
            case TASK_STATUSES.CANCELLED:
                return '🚫';
            case TASK_STATUSES.QUEUED:
                return '🕒';
            case TASK_STATUSES.DOWNLOADING:
            case TASK_STATUSES.DOWNLOADED:
            case TASK_STATUSES.UPLOADING:
                return '🔄';
            default:
                return '•';
        }
    }

    static _getTaskStatusText(status) {
        switch (status) {
            case TASK_STATUSES.COMPLETED:
                return '完成';
            case TASK_STATUSES.FAILED:
                return '失败';
            case TASK_STATUSES.CANCELLED:
                return '已取消';
            case TASK_STATUSES.QUEUED:
                return '排队中';
            case TASK_STATUSES.DOWNLOADING:
                return '下载中';
            case TASK_STATUSES.DOWNLOADED:
                return '等待转存';
            case TASK_STATUSES.UPLOADING:
                return '上传中';
            default:
                return '未知';
        }
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
        const canUseIntegration = await AuthGuard.can(userId, "system:admin");
        if (!canUseIntegration) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        try {
            const token = await ApiKeyRepository.getOrCreateToken(userId);
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: format(STRINGS.system.integration_token, { token }),
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
        const canUseIntegration = await AuthGuard.can(userId, "system:admin");
        if (!canUseIntegration) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: STRINGS.system.integration_help,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 处理 /help 命令
     */
    static async _handleHelpCommand(target, userId) {
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
        const isOwner = userId === getOwnerId();
        const { message, buttons } = this._buildHelpPayload(isAdmin, isOwner);

        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: message,
            buttons,
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 发送绑定提示
     */
    static async _sendBindHint(target, userId) {
        return await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: STRINGS.drive.no_drive_found,
            buttons: this._getNoDriveButtons(),
            parseMode: "html"
        }), userId, {}, false, 3);
    }

    /**
     * [私有] 处理 /diagnosis 命令 (管理员专用)
     */
    static async _handleDiagnosisCommand(target, userId) {
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
        if (!isAdmin) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const placeholder = await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: "🔍 正在执行系统诊断..."
        }), userId, {}, false, 3);

        (async () => {
            try {
                const { message, buttons } = await this._buildDiagnosisReport(userId);
                await safeEdit(target, placeholder.id, message, buttons, userId);
            } catch (error) {
                log.error("Diagnosis error:", error);
                await safeEdit(target, placeholder.id, "❌ 诊断暂时无法完成，请稍后重试。", this._getStatusButtons(true), userId);
            }
        })();
    }

    static async _buildDiagnosisReport(userId) {
        const isAdmin = await AuthGuard.can(userId, "maintenance:bypass");
        if (!isAdmin) {
            return { message: STRINGS.status.no_permission, buttons: null };
        }

        const [networkResults, instanceInfo] = await Promise.all([
            NetworkDiagnostic.diagnoseAll(),
            this._getInstanceInfo()
        ]);
        const memUsage = process.memoryUsage();
        const rss = Math.round(memUsage.rss / 1024 / 1024);
        const heapUsed = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotal = Math.round(memUsage.heapTotal / 1024 / 1024);

        return {
            message: UIHelper.renderDiagnosisReport({
                networkResults,
                instanceInfo,
                systemResources: {
                    memoryMB: `${rss}MB (${heapUsed}MB/${heapTotal}MB)`,
                    uptime: this._getUptime()
                }
            }),
            buttons: this._getStatusButtons(true)
        };
    }

    static async _editDiagnosisReport(event, userId) {
        try {
            await safeEdit(event.userId, event.msgId, "🔍 正在执行系统诊断...", null, userId);
            const { message, buttons } = await this._buildDiagnosisReport(userId);
            await safeEdit(event.userId, event.msgId, message, buttons, userId);
        } catch (error) {
            log.error("Diagnosis callback error:", error);
            await safeEdit(event.userId, event.msgId, "❌ 诊断暂时无法完成，请稍后重试。", this._getStatusButtons(true), userId);
        }
    }

    /**
     * [私有] 全局任务队列查看（管理员）
     */
    static async _handleTaskQueueCommand(target, userId) {
        const isAdmin = await AuthGuard.can(userId, "system:admin");
        if (!isAdmin) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const placeholder = await runBotTaskWithRetry(() => client.sendMessage(target, {
            message: STRINGS.task_queue.loading
        }), userId, {}, false, 3);

        (async () => {
            try {
                const { text, buttons } = await this._buildTaskQueueOverview(userId);
                await safeEdit(target, placeholder.id, text, buttons, userId);
            } catch (error) {
                log.error("Task queue error:", error);
                await safeEdit(target, placeholder.id, STRINGS.task_queue.error, this._getStatusButtons(true), userId);
            }
        })();
    }

    static async _buildTaskQueueOverview(userId) {
        const isAdmin = await AuthGuard.can(userId, "system:admin");
        if (!isAdmin) {
            return { text: STRINGS.status.no_permission, buttons: null };
        }

        const { TaskRepository } = await import("../repositories/TaskRepository.js");
        const data = await TaskRepository.getQueueOverview(10);
        return UIHelper.renderTaskQueue(data);
    }

    static async _editTaskQueueOverview(event, userId) {
        try {
            await safeEdit(event.userId, event.msgId, STRINGS.task_queue.loading, null, userId);
            const { text, buttons } = await this._buildTaskQueueOverview(userId);
            await safeEdit(event.userId, event.msgId, text, buttons, userId);
        } catch (error) {
            log.error("Task queue callback overview error:", error);
            await safeEdit(event.userId, event.msgId, STRINGS.task_queue.error, this._getStatusButtons(true), userId);
        }
    }

    /**
     * [私有] 任务队列翻页回调
     */
    static async _handleTaskQueueCallback(event, data, userId, answerCallback) {
        try {
            const isAdmin = await AuthGuard.can(userId, "system:admin");
            if (!isAdmin) {
                return await answerCallback(STRINGS.status.no_permission);
            }

            const { TaskRepository } = await import("../repositories/TaskRepository.js");

            if (data === "tq_back") {
                const overviewData = await TaskRepository.getQueueOverview(10);
                const { text, buttons } = UIHelper.renderTaskQueue(overviewData);
                await safeEdit(event.userId, event.msgId, text, buttons, userId);
                return await answerCallback();
            }

            // 解析 tq_{status}_{page} 或 tq_refresh_{status}_{page}
            const cleanData = data.replace("tq_refresh_", "tq_");
            const parts = cleanData.split("_");
            const status = parts[1];
            const page = parseInt(parts[2]) || 0;

            const detailData = await TaskRepository.getTasksByStatus(status, page, 8);
            const { text, buttons } = UIHelper.renderTaskQueueDetail(status, detailData);
            await safeEdit(event.userId, event.msgId, text, buttons, userId);
            await answerCallback();
        } catch (error) {
            log.error("Task queue callback error:", error);
            await answerCallback("暂时无法查询任务队列");
        }
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
            instanceInfo.tgActive = Boolean(isClientActive());
            instanceInfo.isTgLeader = await instanceCoordinator.hasLock('telegram_client', { logContention: false });

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

        const normalizedMode = mode === "private" ? "private" : "public";
        return await this._askAdminActionConfirmation(target, userId, {
            type: "access_mode",
            mode: normalizedMode,
            label: normalizedMode === "public" ? "开启公开访问" : "进入维护模式",
            target: "服务访问模式"
        });
    }

    /**
     * [私有] 处理管理员设置命令 (/pro_admin, /de_admin)
     */
    static async _handleAdminPromotion(target, userId, fullText, isPromotion) {
        const isOwner = userId === getOwnerId();
        if (!isOwner) {
            return await runBotTaskWithRetry(() => client.sendMessage(target, {
                message: STRINGS.status.no_permission,
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const command = fullText.split(/\s+/)[0];
        const targetUid = this._getCommandArg(fullText);
        if (!targetUid) {
            return await this._sendAdminUsage(target, userId, command);
        }

        return await this._askAdminActionConfirmation(target, userId, {
            type: "admin_role",
            operation: isPromotion ? "grant" : "revoke",
            targetUid,
            label: isPromotion ? "设置管理员" : "取消管理员",
            target: `用户 ${targetUid}`
        });
    }

    /**
     * [私有] 处理管理员封禁/解封命令 (/ban, /unban)
     */
    static async _handleBanCommand(target, userId, fullText, isBan) {
        const canManage = await AuthGuard.can(userId, "system:admin");
        if (!canManage) {
            return await this._sendAdminError(target, userId, STRINGS.status.no_permission);
        }

        const command = fullText.split(/\s+/)[0];
        const targetUid = this._getCommandArg(fullText);
        if (!targetUid) {
            return await this._sendAdminUsage(target, userId, command);
        }
        
        // 防止封禁自己或 Owner
        if (isBan) {
            if (targetUid === userId) {
                return await this._sendAdminError(target, userId, STRINGS.status.cannot_ban_self);
            }
            if (targetUid === getOwnerId()) {
                return await this._sendAdminError(target, userId, STRINGS.status.cannot_ban_owner);
            }
        }

        return await this._askAdminActionConfirmation(target, userId, {
            type: "user_ban",
            operation: isBan ? "ban" : "unban",
            targetUid,
            label: isBan ? "封禁用户" : "解封用户",
            target: `用户 ${targetUid}`
        });
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
                buttons: this._getNoDriveButtons(),
                parseMode: "html"
            }), userId, {}, false, 3);
        }

        const { message, buttons } = await this._buildRemoteFolderMenu(userId);

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
                buttons: this._getNoDriveButtons(),
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
                    buttons: this._getRemoteFolderInputButtons(),
                    parseMode: "html"
                }), userId, {}, false, 3);
            }

            // 情况2: 重置为默认路径
            if (pathArg === 'reset' || pathArg === 'default') {
                await this._setUserUploadPathInD1(userId, null);
                
                const defaultPath = getDefaultRemoteFolder();
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: format(STRINGS.remote_folder.reset_success, { 
                        path: defaultPath
                    }),
                    buttons: [
                        [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))]
                    ],
                    parseMode: "html"
                }), userId, {}, false, 3);
            }

            // 情况3: 设置新路径
            if (!CloudTool._validatePath(pathArg)) {
                return await runBotTaskWithRetry(() => client.sendMessage(target, {
                    message: STRINGS.remote_folder.invalid_path,
                    buttons: this._getRemoteFolderInputButtons(),
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
                buttons: [
                    [Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))],
                    [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))]
                ],
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
            const normalizedText = text.toLowerCase();
            if (["/cancel", "cancel", "/取消", "取消"].includes(normalizedText)) {
                await SessionManager.clear(userId);
                await runBotTaskWithRetry(() => client.sendMessage(peerId, {
                    message: STRINGS.remote_folder.input_cancelled,
                    buttons: [
                        [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))]
                    ],
                    parseMode: "html"
                }), userId, {}, false, 3);
                return true;
            }

            const routeEscapes = new Set([
                "/start",
                "/help",
                "/drive",
                "/files",
                "/status",
                "/remote_folder"
            ]);
            if (routeEscapes.has(normalizedText.split(" ")[0])) {
                await SessionManager.clear(userId);
                return false;
            }

            // 验证路径格式
            if (!CloudTool._validatePath(text)) {
                await runBotTaskWithRetry(() => client.sendMessage(peerId, {
                    message: STRINGS.remote_folder.invalid_path,
                    buttons: this._getRemoteFolderInputButtons(),
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
                    buttons: [
                        [Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))],
                        [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))]
                    ],
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
            const activeDrive = await DriveRepository.getDefaultDrive(userId);
            
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
            const activeDrive = await DriveRepository.getDefaultDrive(userId);
            
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
            await safeEdit(event.userId, event.msgId, STRINGS.remote_folder.input_prompt, this._getRemoteFolderInputButtons(), userId);
            await answerCallback("");
        } else if (data === "remote_folder_reset_confirm") {
            await safeEdit(event.userId, event.msgId, format(STRINGS.remote_folder.reset_confirm, { path: getDefaultRemoteFolder() }), [
                [Button.inline(STRINGS.remote_folder.btn_cancel, Buffer.from("remote_folder_menu"))],
                [Button.inline(STRINGS.remote_folder.btn_confirm_reset, Buffer.from("remote_folder_reset"))]
            ], userId);
            await answerCallback("");
        } else if (data === "remote_folder_reset") {
            await this._setUserUploadPathInD1(userId, null);
            await safeEdit(event.userId, event.msgId, format(STRINGS.remote_folder.reset_success, { path: getDefaultRemoteFolder() }), [
                [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))],
                [Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))]
            ], userId);
            await answerCallback("");
        } else if (data === "remote_folder_cancel") {
            await SessionManager.clear(userId);
            await safeEdit(event.userId, event.msgId, STRINGS.remote_folder.input_cancelled, [
                [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_set"))]
            ], userId);
            await answerCallback("");
        } else if (data === "remote_folder_menu") {
            const { message, buttons } = await this._buildRemoteFolderMenu(userId);
            await safeEdit(event.userId, event.msgId, message, buttons, userId);
            await answerCallback("");
        } else {
            await answerCallback("");
        }
    }
}
