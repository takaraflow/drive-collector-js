import { Button } from "telegram/tl/custom/button.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { escapeHTML } from "../utils/common.js";
import { DriveProviderFactory } from "../services/drives/index.js";
import { BindingService } from "../services/drives/BindingService.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('DriveConfigFlow') : logger;

// 网盘国际化字符串缓存
const driveStringsCache = new Map();
const CANCEL_KEYWORDS = new Set(["/cancel", "cancel", "/取消", "取消"]);

/**
 * 驱动配置流程模块
 * 负责网盘的绑定、解绑以及相关会话交互
 */
export class DriveConfigFlow {
    /**
     * 获取支持的网盘列表
     * @returns {Array<{type: string, name: string}>}
     */
    static getSupportedDrives() {
        return DriveProviderFactory.getSupportedDrives();
    }

    static _appendCancelHint(prompt, driveStrings) {
        const hint = driveStrings?.cancel_prompt || STRINGS.drive.cancel_prompt;
        if (!prompt) return hint || '';
        return hint ? `${prompt}\n\n${hint}` : prompt;
    }

    /**
     * 发送网盘管理面板
     * @param {string} chatId 
     * @param {string} userId 
     */
    static async sendDriveManager(chatId, userId) {
        const drives = await DriveRepository.findByUserId(userId);
        const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
        
        let message = STRINGS.drive.menu_title;
        const buttons = [];

        if (drives && drives.length > 0) {
            message += `\n${STRINGS.drive.bound_list_title}\n`;
            drives.forEach(drive => {
                // 安全获取drive.name，避免undefined显示
                const driveName = drive.name || '未知账号';
                const email = driveName.split('-').slice(1).join('-') || driveName;
                const isDefault = drive.id === defaultDriveId;
                const statusIcon = isDefault ? '⭐️' : '📁';
                // 安全获取drive.type，避免undefined显示
                const driveType = drive.type || '未知类型';
                message += `\n${statusIcon} <b>${driveType.toUpperCase()}</b> - ${escapeHTML(email)}`;
                if (isDefault) {
                    message += ` (${STRINGS.drive.is_default})`;
                }
            });
            message += '\n';

            drives.forEach(drive => {
                const driveButtons = [];
                if (drive.id !== defaultDriveId) {
                    driveButtons.push(Button.inline(STRINGS.drive.btn_set_default, Buffer.from(`drive_set_default_${drive.id}`)));
                }
                driveButtons.push(Button.inline(STRINGS.drive.btn_unbind, Buffer.from(`drive_unbind_confirm_${drive.id}`)));
                buttons.push(driveButtons);
            });
            
            buttons.push([
                Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))
            ]);
        } else {
            message += STRINGS.drive.not_bound;
        }

        const supportedDrives = this.getSupportedDrives();
        buttons.push([
            Button.inline(`➕ ${STRINGS.drive.btn_bind_other}`, Buffer.from("drive_select_type"))
        ]);

        await runBotTaskWithRetry(() => client.sendMessage(chatId, { message, buttons, parseMode: "html" }), userId, {}, false, 3);
    }

    /**
     * 处理管理面板的按钮回调
     * @param {Object} event Telegram 事件对象
     * @param {string} userId 
     * @returns {Promise<string|null>} 返回给用户的 Toast 提示
     */
    static async handleCallback(event, userId) {
        const data = event.data.toString();

        if (data.startsWith("drive_set_default_")) {
            const driveId = data.split("_")[3];
            await BindingService.setDefaultDrive(userId, driveId);
            await this.sendDriveManager(event.userId, userId); // 刷新界面
            return STRINGS.drive.set_default_success;
        }

        if (data.startsWith("drive_unbind_confirm_")) {
            const driveId = data.split("_")[3];
            const drive = await DriveRepository.findById(driveId);
            if (!drive) {
                return STRINGS.drive.not_found;
            }

            const driveName = drive.name || '未知账号';
            const email = driveName.split('-').slice(1).join('-') || driveName;
            const driveType = drive.type || '未知类型';
            await runBotTaskWithRetry(() => client.editMessage(event.userId, {
                    message: event.msgId,
                    text: format(STRINGS.drive.unbind_confirm, { type: driveType.toUpperCase(), account: escapeHTML(email) }),
                    parseMode: "html",
                    buttons: [
                        [
                            Button.inline(STRINGS.drive.btn_confirm_unbind, Buffer.from(`drive_unbind_execute_${driveId}`)),
                            Button.inline(STRINGS.drive.btn_cancel, Buffer.from("drive_manager_back"))
                        ]
                    ]
                }), userId, {}, false, 3);
            return STRINGS.drive.please_confirm;
        }

        if (data.startsWith("drive_unbind_execute_")) {
            const driveId = data.split("_")[3];
            await BindingService.unbindDrive(userId, driveId);
            await this.sendDriveManager(event.userId, userId);
            return STRINGS.drive.success_unbind;
        }

        if (data === "drive_manager_back") {
            await this.sendDriveManager(event.userId, userId);
            return STRINGS.drive.returned;
        }

        if (data === "drive_select_type") {
            return await this._handleDriveTypeSelection(event, userId);
        }
        
        if (data.startsWith("drive_bind_")) {
            const driveType = data.replace("drive_bind_", "");
            const result = await BindingService.startBinding(userId, driveType);

            if (result.success) {
                // 获取国际化文本
                const driveStrings = await this._getDriveStrings(driveType);
                const prompt = driveStrings[result.prompt] || STRINGS.drive.check_input;
                const message = this._appendCancelHint(prompt, driveStrings);

                await runBotTask(() => client.sendMessage(event.userId, { message, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
                return STRINGS.drive.check_input;
            }
        }
        
        return null;
    }

    /**
     * 处理用户输入的绑定凭证
     * @param {Object} event 
     * @param {string} userId 
     * @param {Object} session 当前会话状态
     * @returns {Promise<boolean>} 是否拦截了消息
     */
    static async handleInput(event, userId, session) {
        const text = event.message.message;
        const step = session.current_step;
        const peerId = event.message.peerId;

        if (!step) return false;

        // 解析步骤：格式为 "DRIVETYPE:STEP"
        const stepParts = step.split(":");
        if (stepParts.length < 2) {
            // 尝试兼容旧格式 (DRIVETYPE_STEP)
            const parts = step.split("_");
            if (parts.length < 2) return false;

            // 这种兼容逻辑很脆弱，因为 driveType 和 step 都可能有下划线
            // 我们可以尝试通过匹配已注册的 Provider 来识别
            const supportedTypes = DriveProviderFactory.getSupportedTypes();
            let matchedType = null;
            let matchedStep = null;

            for (const type of supportedTypes) {
                if (step.toUpperCase().startsWith(type.toUpperCase() + "_")) {
                    matchedType = type;
                    matchedStep = step.slice(type.length + 1);
                    break;
                }
            }

            if (!matchedType) return false;

            const driveType = matchedType.toLowerCase();
            const stepName = matchedStep;

            return await this._processInput(event, userId, session, driveType, stepName);
        }

        const driveType = stepParts[0].toLowerCase();
        const stepName = stepParts.slice(1).join(":");

        return await this._processInput(event, userId, session, driveType, stepName);
    }

    /**
     * 内部处理输入逻辑
     * @private
     */
    static async _processInput(event, userId, session, driveType, stepName) {
        const text = event.message.message;
        const peerId = event.message.peerId;

        if (!DriveProviderFactory.isSupported(driveType)) {
            return false;
        }

        const sessionData = session.temp_data ? JSON.parse(session.temp_data) : {};
        const providerSession = { ...session, data: sessionData };

        const provider = DriveProviderFactory.create(driveType);
        const bindingSteps = provider.getBindingSteps();
        const finalStep = bindingSteps?.[bindingSteps.length - 1]?.step;
        const isFinalStep = finalStep === stepName;

        const driveStrings = await this._getDriveStrings(driveType);

        const normalizedText = (text || "").trim();
        if (CANCEL_KEYWORDS.has(normalizedText.toLowerCase())) {
            await SessionManager.clear(userId);
            const cancelMessage = driveStrings.cancelled || STRINGS.drive.cancelled;
            await runBotTask(() => client.sendMessage(peerId, { message: cancelMessage, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
            return true;
        }

        let verifyingMessage = null;
        if (isFinalStep) {
            try {
                await runMtprotoTask(() => client.deleteMessages(peerId, [event.message.id], { revoke: true }), { priority: PRIORITY.HIGH });
            } catch (error) {
                log.warn(`Failed to delete drive input message for ${userId}:`, error);
            }

            const validatingText = driveStrings.verifying || STRINGS.drive.mega_verifying || "⏳ 正在验证账号，请稍候...";
            verifyingMessage = await runBotTask(() => client.sendMessage(peerId, { message: validatingText, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
        }

        try {
            const result = await provider.handleInput(stepName, text, providerSession);

            if (!result.success) {
                if (!isFinalStep) {
                    await runBotTask(() => client.sendMessage(peerId, { message: result.message }), userId, { priority: PRIORITY.HIGH });
                    return true;
                }

                await SessionManager.clear(userId);
                const targetMessageId = verifyingMessage?.id || event.message.id;
                const failureMessage = this._buildFailureMessage(driveType, result);
                await runBotTask(() => client.editMessage(peerId, {
                    message: targetMessageId,
                    text: failureMessage,
                    parseMode: "html"
                }), userId, { priority: PRIORITY.HIGH });
                return true;
            }

            if (result.nextStep) {
                await SessionManager.update(userId, `${driveType.toUpperCase()}_${result.nextStep}`, result.data);

                const prompt = driveStrings[result.message] || result.message;
                const message = this._appendCancelHint(prompt, driveStrings);
                await runBotTask(() => client.sendMessage(peerId, { message, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
                return true;
            }

            const configData = result.data;
            const driveName = `${driveType.charAt(0).toUpperCase() + driveType.slice(1)}-${configData.user}`;

            await DriveRepository.create(userId, driveName, driveType, configData);
            await SessionManager.clear(userId);

            const successMessage = result.message || driveStrings.success || STRINGS.drive.mega_success;
            const targetMessageId = verifyingMessage?.id || event.message.id;
            await runBotTask(() => client.editMessage(peerId, {
                message: targetMessageId,
                text: successMessage,
                parseMode: "html"
            }), userId, { priority: PRIORITY.HIGH });
            return true;
        } catch (error) {
            log.error(`Error handling drive input for ${driveType}:`, error);
            await runBotTask(() => client.sendMessage(peerId, { message: `❌ 处理错误: ${error.message}` }), userId, { priority: PRIORITY.HIGH });
            return true;
        }
    }

    /**
     * 处理解绑动作 (删除用户所有网盘)
     */
    static async handleUnbind(chatId, userId) { 
        const drives = await DriveRepository.findByUserId(userId);

        if (!drives || drives.length === 0) {
            return await runBotTask(() => client.sendMessage(chatId, { message: STRINGS.drive.no_drive_unbind, parseMode: "html" }), userId);
        }

        // 使用 Repository 删除所有网盘
        await DriveRepository.deleteByUserId(userId);
        await SettingsRepository.set(`default_drive_${userId}`, null);
        await SessionManager.clear(userId);

        await runBotTask(() => client.sendMessage(chatId, { 
                message: STRINGS.drive.unbind_success,
                parseMode: "html"
            }), userId
        );
    }

    /**
     * 获取网盘国际化字符串
     * @param {string} driveType - 网盘类型
     * @returns {Promise<Object>} 国际化字符串对象
     */
    static async _getDriveStrings(driveType) {
        // 使用缓存避免重复动态导入
        if (driveStringsCache.has(driveType)) {
            return driveStringsCache.get(driveType);
        }

        let strings = {};
        let fallbackStrings = {};

        // 1. 加载通用兜底字符串 (drive.js)
        try {
            const fallbackModule = await import(`../locales/drives/drive.js`);
            fallbackStrings = fallbackModule.STRINGS || {};
        } catch (e) {
            log.warn('Generic drive strings not found');
        }

        // 2. 尝试加载特定网盘字符串
        try {
            const module = await import(`../locales/drives/${driveType}.js`);
            const specificStrings = module.STRINGS || {};
            // 合并：特定网盘文案覆盖通用文案
            strings = { ...fallbackStrings, ...specificStrings };
            driveStringsCache.set(driveType, strings);
            return strings;
        } catch (error) {
            log.warn(`Failed to load specific drive strings for ${driveType}, using fallback`);
            strings = fallbackStrings;
        }

        driveStringsCache.set(driveType, strings);
        return strings;
    }

    /**
     * 构建失败消息 (兼容 legacy zh-CN strings)
     */
    static _buildFailureMessage(driveType, result) {
        if (driveType !== 'mega' || !result.reason) {
            return result.message;
        }

        const legacySuffixes = {
            '2FA': STRINGS.drive.mega_fail_2fa,
            'LOGIN_FAILED': STRINGS.drive.mega_fail_login
        };

        const suffix = legacySuffixes[result.reason];
        return suffix ? `${result.message}${suffix}` : result.message;
    }
    
    /**
     * 处理网盘类型选择 - 显示网盘选择列表
     * @param {Object} event Telegram 事件对象
     * @param {string} userId 
     * @returns {Promise<string|null>}
     */
    static async _handleDriveTypeSelection(event, userId) {
        const supportedDrives = this.getSupportedDrives();
        
        const message = `➕ <b>选择要绑定的网盘</b>\n\n请选择您要绑定的网盘类型：`;
        
        const buttons = [];
        supportedDrives.forEach(drive => {
            buttons.push([
                Button.inline(drive.name, Buffer.from(`drive_bind_${drive.type}`))
            ]);
        });
        buttons.push([
            Button.inline(STRINGS.drive.btn_cancel, Buffer.from("drive_manager_back"))
        ]);
        
        await runBotTaskWithRetry(() => client.editMessage(event.userId, {
            message: event.msgId,
            text: message,
            parseMode: "html",
            buttons: buttons
        }), userId, {}, false, 3);
        
        return STRINGS.drive.please_confirm;
    }
}
