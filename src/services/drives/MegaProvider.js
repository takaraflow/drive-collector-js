import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/mega.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('MegaProvider') : logger;

/**
 * Mega 网盘 Provider 实现
 */
export class MegaProvider extends BaseDriveProvider {
    constructor() {
        super('mega', 'Mega 网盘');
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
        if (typeof CloudTool._obscure === "function") {
            return await CloudTool._obscure(password);
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
            let errorReason = validation.reason || 'ERROR';
            if (errorReason === 'ERROR' && validation.details?.includes("couldn't login")) {
                errorReason = 'LOGIN_FAILED';
            }
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
        let errorText = STRINGS.bind_failed;
        
        if (validation.reason === '2FA') {
            errorText += `\n\n${this.getErrorMessage('2FA')}`;
        } else if (validation.details?.includes("couldn't login")) {
            errorText += `\n\n${this.getErrorMessage('LOGIN_FAILED')}`;
        } else {
            const safeDetails = (validation.details || '').slice(-200);
            errorText += `\n\n${STRINGS.fail_network}: <code>${safeDetails}</code>`;
        }
        
        return errorText;
    }
}
