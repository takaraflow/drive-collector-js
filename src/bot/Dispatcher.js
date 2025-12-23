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
import { safeEdit } from "../utils/common.js";
import { runBotTask } from "../utils/limiter.js";
import { STRINGS, format } from "../locales/zh-CN.js";

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
        if (event instanceof Api.UpdateBotCallbackQuery) {
            await this._handleCallback(event, ctx);
        } else if (event instanceof Api.UpdateNewMessage && event.message) {
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

        if (event instanceof Api.UpdateBotCallbackQuery) {
            userId = event.userId.toString();
            target = event.peer;
            isCallback = true;
        } else if (event instanceof Api.UpdateNewMessage && event.message) {
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
        const role = await AuthGuard.getRole(userId);
        const isOwner = userId === config.ownerId?.toString();

        if (!isOwner && !(await AuthGuard.can(userId, "maintenance:bypass"))) {
            // 使用 SettingsRepository
            const mode = await SettingsRepository.get("access_mode", "public");

            if (mode !== 'public') {
                const text = "🚧 **系统维护中**\n\n当前 Bot 仅限管理员使用，请稍后访问。";
                if (isCallback) {
                    await runBotTask(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
                        queryId: event.queryId,
                        message: "🚧 系统维护中",
                        alert: true
                    })).catch(() => {}), userId);
                } else if (target) {
                    await runBotTask(() => client.sendMessage(target, { message: text }), userId);
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
        const answer = (msg = "") => runBotTask(() => client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: event.queryId,
            message: msg
        })).catch(() => {}), userId);

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

        // 1. 会话拦截 (密码输入等)
        const session = await SessionManager.get(userId);
        if (session) {
            const handled = await DriveConfigFlow.handleInput(event, userId, session);
            if (handled) return; 
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
                // 更多命令可在此添加...
            }

            // 3. 尝试解析链接
            try {
                const toProcess = await LinkParser.parse(text, userId);
                if (toProcess && toProcess.length > 0) {
                    const drive = await DriveRepository.findByUserId(userId);
                    if (!drive) return await this._sendBindHint(target, userId);

                    if (toProcess.length > 10) await runBotTask(() => client.sendMessage(target, { message: `⚠️ 仅处理前 10 个媒体。` }), userId);
                    for (const msg of toProcess.slice(0, 10)) await TaskManager.addTask(target, msg, userId, "链接");
                    return;
                }
            } catch (e) {
                return await runBotTask(() => client.sendMessage(target, { message: `❌ ${e.message}` }), userId);
            }

            // 4. 通用兜底回复：
            // 如果是纯文本消息（包括未匹配的命令），且未被上述逻辑处理，则发送欢迎语。
            return await runBotTask(() => client.sendMessage(target, { 
                message: STRINGS.system.welcome
            }), userId);
        }

        // 5. 处理带媒体的消息 (文件/视频/图片)
        if (message.media) {
            const drive = await DriveRepository.findByUserId(userId);
            if (!drive) return await this._sendBindHint(target, userId);

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
     * [私有] 处理 /files 命令
     */
    static async _handleFilesCommand(target, userId) {
        const drive = await DriveRepository.findByUserId(userId);
        if (!drive) return await this._sendBindHint(target, userId);

        const placeholder = await runBotTask(() => client.sendMessage(target, { message: "⏳ 正在拉取云端文件列表..." }), userId);
        await new Promise(r => setTimeout(r, 100));
        
        const files = await CloudTool.listRemoteFiles(userId);
        const { text, buttons } = UIHelper.renderFilesPage(files, 0, 6, CloudTool.isLoading());
        return await safeEdit(target, placeholder.id, text, buttons, userId);
    }

    /**
     * [私有] 发送绑定提示
     */
    static async _sendBindHint(target, userId) {
        return await runBotTask(() => client.sendMessage(target, { 
            message: STRINGS.drive.no_drive_found
        }), userId);
    }
}