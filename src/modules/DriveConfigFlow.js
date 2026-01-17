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
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('DriveConfigFlow') : logger;

// 网盘国际化字符串缓存
const driveStringsCache = new Map();

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
            await SettingsRepository.set(`default_drive_${userId}`, driveId);
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
            await DriveRepository.delete(driveId);
            await SettingsRepository.set(`default_drive_${userId}`, null);
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
            const driveType = data.split("_")[2];
            const provider = DriveProviderFactory.create(driveType);
            const steps = provider.getBindingSteps();
            
            if (steps.length > 0) {
                const firstStep = steps[0];
                await SessionManager.start(userId, `${driveType.toUpperCase()}_${firstStep.step}`);
                
                // 获取国际化文本
                const driveStrings = await this._getDriveStrings(driveType);
                const prompt = driveStrings[firstStep.prompt] || STRINGS.drive.check_input;
                
                await runBotTask(() => client.sendMessage(event.userId, { message: prompt, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
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

        // 解析步骤：格式为 "DRIVETYPE_STEP"
        const stepParts = step.split("_");
        if (stepParts.length < 2) return false;
        
        const driveType = stepParts[0].toLowerCase();
        const stepName = stepParts.slice(1).join("_");
        
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
                await runBotTask(() => client.sendMessage(peerId, { message: prompt, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
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

        // 动态导入对应的国际化文件
        try {
            const module = await import(`../locales/drives/${driveType}.js`);
            const strings = module.STRINGS || {};
            driveStringsCache.set(driveType, strings);
            return strings;
        } catch (error) {
            log.warn(`Failed to load drive strings for ${driveType}:`, error);
        }
        const emptyStrings = {};
        driveStringsCache.set(driveType, emptyStrings);
        return emptyStrings;
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
