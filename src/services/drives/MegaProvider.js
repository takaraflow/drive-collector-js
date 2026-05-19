import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/mega.js";
import { logger } from "../logger/index.js";
import { classifyRcloneError, RCLONE_ERROR_CODES } from "../../domain/rclone-error.js";

const log = logger.withModule ? logger.withModule('MegaProvider') : logger;

/**
 * Mega 网盘 Provider 实现
 */
export class MegaProvider extends BaseDriveProvider {
    constructor() {
        super('mega', 'Mega 网盘', {
            supportLevel: 'stable',
            supportNote: 'Direct username/password binding with rclone validation.'
        });
    }

    /**
     * 获取绑定步骤配置
     */
    getBindingSteps() {
        return [
            new BindingStep('WAIT_EMAIL', 'input_email', this._validateEmail.bind(this)),
            new BindingStep('WAIT_PASS', 'input_pass')
        ];
    }

    /**
     * 处理用户输入
     */
    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_EMAIL':
                return this._handleEmailInput(input, session);
            case 'WAIT_PASS':
                return this._handlePassInput(input, session);
            default:
                return new ActionResult(false, '未知步骤');
        }
    }

    /**
     * 验证配置
     */
    async validateConfig(configData) {
        try {
            const processedPass = await this.processPassword(configData.pass);

            // 调用 rclone 验证
            const result = await CloudTool.validateConfig(this.type, {
                user: configData.user,
                pass: processedPass
            });

            if (result.success) {
                return new ValidationResult(true);
            } else {
                return new ValidationResult(false, result.reason, result.details);
            }
        } catch (error) {
            log.error('Mega validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    /**
     * 处理密码（使用 rclone obscure）
     */
    async processPassword(password) {
        if (typeof CloudTool.normalizePasswordForRclone === "function") {
            return await CloudTool.normalizePasswordForRclone(password);
        }

        return password;
    }

    /**
     * 获取错误消息
     */
    getErrorMessage(errorType) {
        const errorMessages = {
            '2FA': STRINGS.fail_2fa,
            'LOGIN_FAILED': STRINGS.fail_login,
            'NETWORK_ERROR': STRINGS.fail_network,
            'UNKNOWN': STRINGS.fail_unknown
        };
        return errorMessages[errorType] || errorMessages['UNKNOWN'];
    }

    /**
     * 验证邮箱格式
     */
    _validateEmail(email) {
        if (!email || !email.includes('@')) {
            return { valid: false, message: STRINGS.email_invalid };
        }
        return { valid: true };
    }

    /**
     * 处理邮箱输入
     */
    _handleEmailInput(input, session) {
        const validation = this._validateEmail(input);
        if (!validation.valid) {
            return new ActionResult(false, validation.message);
        }
        
        return new ActionResult(
            true,
            STRINGS.input_pass,
            'WAIT_PASS',
            { email: input.trim() }
        );
    }

    /**
     * 处理密码输入
     */
    async _handlePassInput(input, session) {
        const email = session.data?.email;
        if (!email) {
            return new ActionResult(false, STRINGS.email_invalid || '请先输入邮箱');
        }
        
        const password = input.trim();
        
        const configData = { user: email, pass: password };
        const validation = await this.validateConfig(configData);
        
        if (!validation.success) {
            const errorMsg = this._formatErrorMessage(validation);
            const errorReason = this._normalizeValidationReason(validation);
            return new ActionResult(false, errorMsg, null, null, errorReason);
        }
        
        return new ActionResult(
            true,
            STRINGS.success.replace('{{email}}', email),
            null,
            configData
        );
    }

    /**
     * 格式化错误消息
     */
    _formatErrorMessage(validation) {
        const reason = this._normalizeValidationReason(validation);
        if (reason === '2FA') {
            return this.getErrorMessage('2FA');
        }

        if (reason === 'LOGIN_FAILED') {
            return this.getErrorMessage('LOGIN_FAILED');
        }

        return this.getErrorMessage('NETWORK_ERROR');
    }

    _normalizeValidationReason(validation) {
        if (validation.reason === '2FA') {
            return '2FA';
        }
        if (validation.reason === 'LOGIN_FAILED') {
            return 'LOGIN_FAILED';
        }

        const classification = classifyRcloneError(validation.details || '');
        if (classification.code === RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID) {
            return 'LOGIN_FAILED';
        }

        return validation.reason || 'ERROR';
    }
}
