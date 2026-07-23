import { Button } from "telegram/tl/custom/button.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { escapeHTML } from "../utils/common.js";
import { DriveProviderFactory } from "../services/drives/index.js";
import { BindingService } from "../services/drives/BindingService.js";
import { logger } from "../services/logger/index.js";
import { isDefaultDrive } from "../domain/drive.js";
import {
    decodeDriveSessionStep,
    encodeDriveSessionStep,
    parseDriveSessionData
} from "../domain/drive-session-step.js";
import { isSensitiveBindingStepName } from "../domain/binding-input.js";

const log = logger.withModule ? logger.withModule('DriveConfigFlow') : logger;

// 网盘国际化字符串缓存
const driveStringsCache = new Map();
const CANCEL_KEYWORDS = new Set(["/cancel", "cancel", "/取消", "取消"]);
const DRIVE_ACTION_LABELS = Object.freeze({
    mega: "🟢 Mega",
    webdav: "🌐 WebDAV",
    google_drive: "🔵 Google Drive",
    onedrive: "☁️ OneDrive",
    pikpak: "🟣 PikPak",
    pcloud: "🔵 pCloud",
    dropbox: "📦 Dropbox",
    box: "📁 Box",
    oss: "🗄️ S3 / OSS",
    protondrive: "🛡️ Proton Drive"
});

/**
 * 驱动配置流程模块
 * 负责网盘的绑定、解绑以及相关会话交互
 */
export class DriveConfigFlow {
    static _callbackValue(data, prefix) {
        return data.startsWith(prefix) ? data.slice(prefix.length) : "";
    }

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

    static _resolveDrivePrompt(prompt, driveStrings) {
        return driveStrings?.[prompt] || STRINGS.drive?.[prompt] || prompt;
    }

    static _appendCredentialNotice(prompt, stepName, provider = null) {
        const notice = STRINGS.drive.credential_notice;
        const sensitive = provider && typeof provider.isSensitiveBindingStep === 'function'
            ? provider.isSensitiveBindingStep(stepName)
            : isSensitiveBindingStepName(stepName);
        if (!prompt || !notice || !sensitive) {
            return prompt;
        }
        return prompt.includes(notice) ? prompt : `${prompt}\n\n${notice}`;
    }

    static _buildBindingPrompt(prompt, driveStrings, stepName, provider = null, stepMeta = null) {
        const promptWithNotice = this._appendCredentialNotice(prompt, stepName, provider);
        const withSkip = this._appendSkipHint(promptWithNotice, driveStrings, stepMeta);
        return this._appendCancelHint(withSkip, driveStrings);
    }

    static _appendSkipHint(prompt, driveStrings, stepMeta) {
        if (!stepMeta?.optional) return prompt || '';
        const hint = driveStrings?.skip_prompt || STRINGS.drive.skip_prompt;
        if (!prompt) return hint || '';
        if (!hint || prompt.includes(hint)) return prompt;
        return `${prompt}\n\n${hint}`;
    }

    static _resolveBindingStep(provider, stepName) {
        if (provider && typeof provider.getBindingStep === 'function') {
            return provider.getBindingStep(stepName);
        }
        const steps = provider?.getBindingSteps?.() || [];
        return steps.find(step => step.step === stepName) || null;
    }

    static _isFinalBindingStep(provider, stepName, session = null) {
        if (provider && typeof provider.isFinalBindingStep === 'function') {
            return provider.isFinalBindingStep(stepName, session) === true;
        }
        const steps = provider?.getBindingSteps?.() || [];
        return steps?.[steps.length - 1]?.step === stepName;
    }

    static _isSensitiveBindingStep(provider, stepName) {
        if (provider && typeof provider.isSensitiveBindingStep === 'function') {
            return provider.isSensitiveBindingStep(stepName) === true;
        }
        return isSensitiveBindingStepName(stepName);
    }

    static _buildStepButtons(stepMeta) {
        const buttons = [];
        const choices = Array.isArray(stepMeta?.choices) ? stepMeta.choices : [];
        for (const choice of choices) {
            if (!choice?.value || !choice?.label) continue;
            buttons.push([Button.inline(choice.label, Buffer.from(`drive_bind_input_${choice.value}`))]);
        }
        if (stepMeta?.optional) {
            buttons.push([Button.inline(STRINGS.drive.btn_skip || '跳过', Buffer.from('drive_bind_input_skip'))]);
        }
        return buttons.length > 0 ? buttons : null;
    }

    static async _sendBindingPrompt(peerId, userId, {
        prompt,
        driveStrings,
        stepName,
        provider = null,
        editMessageId = null
    }) {
        const stepMeta = this._resolveBindingStep(provider, stepName);
        const message = this._buildBindingPrompt(prompt, driveStrings, stepName, provider, stepMeta);
        const buttons = this._buildStepButtons(stepMeta);
        const payload = { message, parseMode: 'html' };
        if (buttons) payload.buttons = buttons;

        if (editMessageId) {
            await runBotTask(() => client.editMessage(peerId, {
                message: editMessageId,
                text: message,
                buttons: buttons || undefined,
                parseMode: 'html'
            }), userId, { priority: PRIORITY.HIGH });
            return;
        }

        await runBotTask(() => client.sendMessage(peerId, payload), userId, { priority: PRIORITY.HIGH });
    }

    static _getBindingRecoveryButtons() {
        return [
            [Button.inline(STRINGS.drive.btn_bind_other, Buffer.from("drive_select_type"))],
            [Button.inline(STRINGS.drive.btn_cancel, Buffer.from("drive_manager_back"))]
        ];
    }

    static _getBindingSuccessButtons() {
        return [
            [Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))],
            [Button.inline(STRINGS.remote_folder.btn_set_path, Buffer.from("remote_folder_menu"))]
        ];
    }

    static _formatDriveButtonLabel(drive) {
        const baseLabel = DRIVE_ACTION_LABELS[drive.type] || `📁 ${drive.name}`;
        if (drive.supportLevel && drive.supportLevel !== 'stable') {
            return `${baseLabel} · ${STRINGS.drive.advanced_config_badge}`;
        }
        return baseLabel;
    }

    static async _buildDriveManagerPayload(userId) {
        const drives = await DriveRepository.findByUserId(userId);
        const defaultDrive = drives?.find(isDefaultDrive) || drives?.[0] || null;
        const defaultDriveId = defaultDrive?.id || null;

        let message = STRINGS.drive.menu_title;
        const buttons = [];

        if (drives && drives.length > 0) {
            message += `\n${STRINGS.drive.bound_list_title}\n`;
            drives.forEach((drive, index) => {
                // 安全获取drive.name，避免undefined显示
                const driveName = drive.name || '未知账号';
                const email = driveName.split('-').slice(1).join('-') || driveName;
                const isDefault = drive.id === defaultDriveId;
                const statusIcon = isDefault ? '⭐️' : '📁';
                // 安全获取drive.type，避免undefined显示
                const driveType = drive.type || '未知类型';
                message += `\n${index + 1}. ${statusIcon} <b>${driveType.toUpperCase()}</b> - ${escapeHTML(email)}`;
                if (isDefault) {
                    message += ` (${STRINGS.drive.is_default})`;
                }
            });
            message += '\n';

            drives.forEach((drive, index) => {
                const driveButtons = [];
                if (drive.id !== defaultDriveId) {
                    driveButtons.push(Button.inline(`${index + 1} ${STRINGS.drive.btn_set_default}`, Buffer.from(`drive_set_default_${drive.id}`)));
                }
                driveButtons.push(Button.inline(`${index + 1} ${STRINGS.drive.btn_unbind}`, Buffer.from(`drive_unbind_confirm_${drive.id}`)));
                buttons.push(driveButtons);
            });
            
            buttons.push([
                Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0"))
            ]);
        } else {
            message += STRINGS.drive.not_bound;
        }

        buttons.push([
            Button.inline(`➕ ${STRINGS.drive.btn_bind_other}`, Buffer.from("drive_select_type"))
        ]);

        return { message, buttons };
    }

    /**
     * 发送网盘管理面板
     * @param {string} chatId
     * @param {string} userId
     */
    static async sendDriveManager(chatId, userId) {
        const { message, buttons } = await this._buildDriveManagerPayload(userId);
        await runBotTaskWithRetry(() => client.sendMessage(chatId, { message, buttons, parseMode: "html" }), userId, {}, false, 3);
    }

    static async _editDriveManager(event, userId) {
        const { message, buttons } = await this._buildDriveManagerPayload(userId);
        await runBotTaskWithRetry(() => client.editMessage(event.userId, {
            message: event.msgId,
            text: message,
            buttons,
            parseMode: "html"
        }), userId, {}, false, 3);
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
            const driveId = this._callbackValue(data, "drive_set_default_");
            await BindingService.setDefaultDrive(userId, driveId);
            await this._editDriveManager(event, userId);
            return STRINGS.drive.set_default_success;
        }

        if (data.startsWith("drive_unbind_confirm_")) {
            const driveId = this._callbackValue(data, "drive_unbind_confirm_");
            const drive = await DriveRepository.findByUserAndId(userId, driveId);
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
                        [Button.inline(STRINGS.drive.btn_keep_drive, Buffer.from("drive_manager_back"))],
                        [Button.inline(STRINGS.drive.btn_confirm_unbind, Buffer.from(`drive_unbind_execute_${driveId}`))]
                    ]
                }), userId, {}, false, 3);
            return STRINGS.drive.please_confirm;
        }

        if (data.startsWith("drive_unbind_execute_")) {
            const driveId = this._callbackValue(data, "drive_unbind_execute_");
            const result = await BindingService.unbindDrive(userId, driveId);
            if (!result.success) {
                return STRINGS.drive.not_found;
            }
            await this._editDriveManager(event, userId);
            return STRINGS.drive.success_unbind;
        }

        if (data === "drive_unbind_all_execute") {
            await DriveRepository.deleteByUserId(userId);
            await SessionManager.clear(userId);
            await this._editDriveManager(event, userId);
            return STRINGS.drive.success_unbind;
        }

        if (data === "drive_manager_back") {
            await this._editDriveManager(event, userId);
            return STRINGS.drive.returned;
        }

        if (data === "drive_select_type") {
            return await this._handleDriveTypeSelection(event, userId, { showAll: false });
        }

        if (data === "drive_select_type_all") {
            return await this._handleDriveTypeSelection(event, userId, { showAll: true });
        }
        
        if (data.startsWith("drive_bind_input_")) {
            const value = this._callbackValue(data, "drive_bind_input_");
            const session = await SessionManager.get(userId);
            if (!session?.current_step) {
                return STRINGS.drive.not_found;
            }
            const parsedStep = decodeDriveSessionStep(session.current_step, DriveProviderFactory.getSupportedTypes());
            if (!parsedStep) {
                return STRINGS.drive.not_found;
            }
            await this._processInput(event, userId, session, parsedStep.driveType, parsedStep.step, {
                textOverride: value === 'skip' ? 'skip' : value,
                source: 'callback'
            });
            return STRINGS.drive.check_input;
        }

        if (data.startsWith("drive_bind_")) {
            const driveType = data.replace("drive_bind_", "");
            const result = await BindingService.startBinding(userId, driveType);

            if (result.success) {
                const driveStrings = await this._getDriveStrings(driveType);
                const provider = DriveProviderFactory.create(driveType);
                const prompt = this._resolveDrivePrompt(result.prompt, driveStrings) || STRINGS.drive.check_input;
                await this._sendBindingPrompt(event.userId, userId, {
                    prompt,
                    driveStrings,
                    stepName: result.step,
                    provider
                });
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
        const step = session.current_step;
        if (!step) return false;

        const parsedStep = decodeDriveSessionStep(step, DriveProviderFactory.getSupportedTypes());
        if (!parsedStep) return false;
        return await this._processInput(event, userId, session, parsedStep.driveType, parsedStep.step);
    }

    /**
     * 内部处理输入逻辑
     * @private
     */
    static async _processInput(event, userId, session, driveType, stepName, options = {}) {
        const source = options.source || 'message';
        const text = options.textOverride != null
            ? options.textOverride
            : event.message?.message;
        const peerId = event.message?.peerId || event.userId;

        if (!DriveProviderFactory.isSupported(driveType)) {
            return false;
        }

        const sessionData = parseDriveSessionData(session);
        const providerSession = { ...session, data: sessionData };

        const provider = DriveProviderFactory.create(driveType);
        const isFinalStep = this._isFinalBindingStep(provider, stepName, providerSession);
        const isSensitiveStep = this._isSensitiveBindingStep(provider, stepName);

        const driveStrings = await this._getDriveStrings(driveType);

        const normalizedText = (text || "").trim();
        if (CANCEL_KEYWORDS.has(normalizedText.toLowerCase())) {
            await SessionManager.clear(userId);
            const cancelMessage = driveStrings.cancelled || STRINGS.drive.cancelled;
            await runBotTask(() => client.sendMessage(peerId, { message: cancelMessage, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
            return true;
        }

        let verifyingMessage = null;
        if (source === 'message' && isSensitiveStep && event.message?.id) {
            try {
                await runMtprotoTask(() => client.deleteMessages(peerId, [event.message.id], { revoke: true }), { priority: PRIORITY.HIGH });
            } catch (error) {
                log.warn(`Failed to delete drive input message for ${userId}:`, error);
            }
        }

        if (isFinalStep) {
            const validatingText = driveStrings.verifying || STRINGS.drive.mega_verifying || "⏳ 正在验证账号，请稍候...";
            verifyingMessage = await runBotTask(() => client.sendMessage(peerId, { message: validatingText, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
        }

        try {
            const result = await provider.handleInput(stepName, text, providerSession);

            if (!result.success) {
                if (!isFinalStep) {
                    const message = this._appendCancelHint(result.message || STRINGS.drive.bind_failed, driveStrings);
                    await runBotTask(() => client.sendMessage(peerId, {
                        message,
                        buttons: this._getBindingRecoveryButtons(),
                        parseMode: "html"
                    }), userId, { priority: PRIORITY.HIGH });
                    return true;
                }

                await SessionManager.clear(userId);
                const targetMessageId = verifyingMessage?.id || event.message?.id;
                const failureMessage = this._buildFailureMessage(driveType, result, provider);
                if (targetMessageId) {
                    await runBotTask(() => client.editMessage(peerId, {
                        message: targetMessageId,
                        text: failureMessage,
                        buttons: this._getBindingRecoveryButtons(),
                        parseMode: "html"
                    }), userId, { priority: PRIORITY.HIGH });
                } else {
                    await runBotTask(() => client.sendMessage(peerId, {
                        message: failureMessage,
                        buttons: this._getBindingRecoveryButtons(),
                        parseMode: "html"
                    }), userId, { priority: PRIORITY.HIGH });
                }
                return true;
            }

            if (result.nextStep) {
                await SessionManager.update(userId, encodeDriveSessionStep(driveType, result.nextStep), result.data);

                const prompt = this._resolveDrivePrompt(result.message, driveStrings);
                await this._sendBindingPrompt(peerId, userId, {
                    prompt,
                    driveStrings,
                    stepName: result.nextStep,
                    provider
                });
                return true;
            }

            const configData = typeof provider.prepareConfigForStorage === "function"
                ? await provider.prepareConfigForStorage(result.data)
                : result.data;
            const displayAccount = provider.getDisplayAccount(configData);
            const driveName = `${driveType.charAt(0).toUpperCase() + driveType.slice(1)}-${displayAccount}`;

            await DriveRepository.create(userId, driveName, driveType, configData);
            await SessionManager.clear(userId);

            const successMessage = result.message || driveStrings.success || STRINGS.drive.mega_success;
            const targetMessageId = verifyingMessage?.id || event.message?.id || event.msgId;
            if (targetMessageId) {
                await runBotTask(() => client.editMessage(peerId, {
                    message: targetMessageId,
                    text: successMessage,
                    buttons: this._getBindingSuccessButtons(),
                    parseMode: "html"
                }), userId, { priority: PRIORITY.HIGH });
            } else {
                await runBotTask(() => client.sendMessage(peerId, {
                    message: successMessage,
                    buttons: this._getBindingSuccessButtons(),
                    parseMode: "html"
                }), userId, { priority: PRIORITY.HIGH });
            }
            return true;
        } catch (error) {
            log.error(`Error handling drive input for ${driveType}:`, error);
            await SessionManager.clear(userId);
            await runBotTask(() => client.sendMessage(peerId, {
                message: STRINGS.drive.bind_error,
                buttons: this._getBindingRecoveryButtons(),
                parseMode: "html"
            }), userId, { priority: PRIORITY.HIGH });
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

        await runBotTask(() => client.sendMessage(chatId, { 
                message: STRINGS.drive.unbind_all_confirm,
                buttons: [
                    [Button.inline(STRINGS.drive.btn_keep_drive, Buffer.from("drive_manager_back"))],
                    [Button.inline(STRINGS.drive.btn_confirm_unbind_all, Buffer.from("drive_unbind_all_execute"))]
                ],
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
    static _buildFailureMessage(driveType, result, provider = null) {
        let reason = result?.message || STRINGS.drive.bind_failed;

        if ((!result?.message || result.message === STRINGS.drive.bind_failed) && result?.reason) {
            if (provider && typeof provider.getErrorMessage === 'function') {
                const providerMessage = provider.getErrorMessage(result.reason);
                if (providerMessage && providerMessage !== '未知错误') {
                    reason = providerMessage;
                }
            } else if (driveType === 'mega') {
                const legacySuffixes = {
                    '2FA': STRINGS.drive.mega_fail_2fa,
                    'LOGIN_FAILED': STRINGS.drive.mega_fail_login
                };
                reason = legacySuffixes[result.reason] || reason;
            }
        }

        return format(STRINGS.drive.bind_failed_help, {
            reason: reason || STRINGS.drive.bind_failed
        });
    }
    
    /**
     * 处理网盘类型选择 - 显示网盘选择列表
     * @param {Object} event Telegram 事件对象
     * @param {string} userId 
     * @returns {Promise<string|null>}
     */
    static async _handleDriveTypeSelection(event, userId, { showAll = false } = {}) {
        const supportedDrives = this.getSupportedDrives();
        const visibleDrives = showAll
            ? supportedDrives
            : supportedDrives.filter(drive => !drive.supportLevel || drive.supportLevel === 'stable');
        const fallbackDrives = visibleDrives.length > 0 ? visibleDrives : supportedDrives;
        const hasAdvancedConfig = fallbackDrives.some(drive => drive.supportLevel && drive.supportLevel !== 'stable');
        const hint = showAll
            ? STRINGS.drive.select_type_more_hint
            : STRINGS.drive.select_type_recommended_hint;
        const statusHint = hasAdvancedConfig ? `\n\n${STRINGS.drive.advanced_config_hint}` : '';
        const message = `${STRINGS.drive.select_type_title}\n\n${hint}${statusHint}`;

        const buttons = [];
        fallbackDrives.forEach(drive => {
            buttons.push([
                Button.inline(this._formatDriveButtonLabel(drive), Buffer.from(`drive_bind_${drive.type}`))
            ]);
        });

        if (supportedDrives.length > fallbackDrives.length) {
            buttons.push([
                Button.inline(`🧰 ${STRINGS.drive.btn_more_drives}`, Buffer.from("drive_select_type_all"))
            ]);
        } else if (showAll) {
            buttons.push([
                Button.inline(`⭐ ${STRINGS.drive.btn_recommended_drives}`, Buffer.from("drive_select_type"))
            ]);
        }

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
