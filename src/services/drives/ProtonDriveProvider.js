import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/protondrive.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('ProtonDriveProvider') : logger;

const BOOLEAN_TRUE_INPUTS = new Set(["1", "true", "yes", "y", "on", "是", "有"]);
const BOOLEAN_FALSE_INPUTS = new Set(["0", "false", "no", "n", "off", "否", "无"]);

export class ProtonDriveProvider extends BaseDriveProvider {
    constructor() {
        super('protondrive', 'Proton Drive', {
            supportLevel: 'advanced',
            supportNote: 'Matches the rclone Proton Drive backend: username/password with optional 2FA, optional TOTP secret, and optional mailbox password. Backend is beta upstream.'
        });
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_USERNAME', 'input_username', this._validateUsername.bind(this)),
            new BindingStep('WAIT_PASSWORD', 'input_password'),
            new BindingStep('WAIT_USE_2FA', 'input_use_2fa', this._validateBoolean.bind(this)),
            new BindingStep('WAIT_2FA', 'input_2fa_optional'),
            new BindingStep('WAIT_OTP_SECRET_KEY', 'input_otp_secret_key_optional'),
            new BindingStep('WAIT_MAILBOX_PASSWORD', 'input_mailbox_password_optional')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_USERNAME':
                return this._handleUsernameInput(input);
            case 'WAIT_PASSWORD':
                return this._handlePasswordInput(input, session);
            case 'WAIT_USE_2FA':
                return this._handleUse2faInput(input, session);
            case 'WAIT_2FA':
                return this._handle2faInput(input, session);
            case 'WAIT_OTP_SECRET_KEY':
                return this._handleOtpSecretInput(input, session);
            case 'WAIT_MAILBOX_PASSWORD':
                return this._handleMailboxPasswordInput(input, session);
            default:
                return new ActionResult(false, '未知步骤');
        }
    }

    async validateConfig(configData) {
        try {
            const runtimeConfig = await this.prepareConfigForRuntime(configData);
            const result = await CloudTool.validateConfig(this.type, runtimeConfig);
            if (result.success) {
                return new ValidationResult(true);
            }
            return new ValidationResult(false, result.reason, result.details);
        } catch (error) {
            log.error('Proton Drive validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    async prepareConfigForStorage(configData = {}) {
        return {
            username: String(configData.username || '').trim(),
            password: await this._normalizeSecret(configData.password, configData.password_format),
            password_format: 'rclone_obscured',
            two_factor: configData.two_factor || '',
            two_factor_enabled: configData.two_factor_enabled === true,
            otp_secret_key: await this._normalizeOptionalSecret(configData.otp_secret_key, configData.otp_secret_key_format),
            otp_secret_key_format: configData.otp_secret_key ? 'rclone_obscured' : null,
            mailbox_password: await this._normalizeOptionalSecret(configData.mailbox_password, configData.mailbox_password_format),
            mailbox_password_format: configData.mailbox_password ? 'rclone_obscured' : null
        };
    }

    async prepareConfigForRuntime(configData = {}) {
        const runtime = {
            ...configData,
            username: String(configData.username || '').trim(),
            password: await this._normalizeSecret(configData.password, configData.password_format || 'rclone_obscured'),
            password_format: 'rclone_obscured'
        };

        if (runtime.otp_secret_key) {
            runtime.otp_secret_key = await this._normalizeSecret(
                runtime.otp_secret_key,
                runtime.otp_secret_key_format || 'rclone_obscured'
            );
            runtime.otp_secret_key_format = 'rclone_obscured';
        }

        if (runtime.mailbox_password) {
            runtime.mailbox_password = await this._normalizeSecret(
                runtime.mailbox_password,
                runtime.mailbox_password_format || 'rclone_obscured'
            );
            runtime.mailbox_password_format = 'rclone_obscured';
        }

        return runtime;
    }

    getValidationCommand() {
        return 'lsd';
    }

    getConnectionString(config) {
        this.assertRequiredConfig(config, ['username', 'password']);
        const username = this._escapeValue(config.username);
        const password = this._escapeValue(config.password);
        const segments = [
            `username="${username}"`,
            `password="${password}"`
        ];

        const twoFactor = String(config.two_factor || '').trim();
        if (twoFactor) {
            segments.push(`2fa="${this._escapeValue(twoFactor)}"`);
        }

        const otpSecretKey = String(config.otp_secret_key || '').trim();
        if (otpSecretKey) {
            segments.push(`otp_secret_key="${this._escapeValue(otpSecretKey)}"`);
        }

        const mailboxPassword = String(config.mailbox_password || '').trim();
        if (mailboxPassword) {
            segments.push(`mailbox_password="${this._escapeValue(mailboxPassword)}"`);
        }

        return `:${this.type},${segments.join(',')}:`;
    }

    getDisplayAccount(config = {}) {
        return config.username || 'protondrive';
    }

    _validateUsername(username) {
        if (!String(username || '').trim()) {
            return { valid: false, message: STRINGS.username_invalid };
        }
        return { valid: true };
    }

    _validateBoolean(input) {
        const normalized = String(input || '').trim().toLowerCase();
        if (BOOLEAN_TRUE_INPUTS.has(normalized) || BOOLEAN_FALSE_INPUTS.has(normalized)) {
            return { valid: true };
        }
        return { valid: false, message: STRINGS.use_2fa_invalid };
    }

    _handleUsernameInput(input) {
        const validation = this._validateUsername(input);
        if (!validation.valid) {
            return new ActionResult(false, validation.message);
        }
        return new ActionResult(true, STRINGS.input_password, 'WAIT_PASSWORD', {
            username: String(input).trim()
        });
    }

    _handlePasswordInput(input, session) {
        const password = String(input || '').trim();
        if (!password) {
            return new ActionResult(false, STRINGS.password_invalid);
        }
        return new ActionResult(true, STRINGS.input_use_2fa, 'WAIT_USE_2FA', {
            ...session.data,
            password
        });
    }

    _handleUse2faInput(input, session) {
        const validation = this._validateBoolean(input);
        if (!validation.valid) {
            return new ActionResult(false, validation.message);
        }

        const normalized = String(input || '').trim().toLowerCase();
        const twoFactorEnabled = BOOLEAN_TRUE_INPUTS.has(normalized);
        const nextPrompt = twoFactorEnabled ? STRINGS.input_2fa_optional : STRINGS.input_otp_secret_key_optional;
        const nextStep = twoFactorEnabled ? 'WAIT_2FA' : 'WAIT_OTP_SECRET_KEY';

        return new ActionResult(true, nextPrompt, nextStep, {
            ...session.data,
            two_factor_enabled: twoFactorEnabled,
            two_factor: ''
        });
    }

    _handle2faInput(input, session) {
        const twoFactor = String(input || '').trim();
        if (session.data?.two_factor_enabled && !twoFactor) {
            return new ActionResult(false, STRINGS.use_2fa_required);
        }
        return new ActionResult(true, STRINGS.input_otp_secret_key_optional, 'WAIT_OTP_SECRET_KEY', {
            ...session.data,
            two_factor: twoFactor
        });
    }

    _handleOtpSecretInput(input, session) {
        return new ActionResult(true, STRINGS.input_mailbox_password_optional, 'WAIT_MAILBOX_PASSWORD', {
            ...session.data,
            otp_secret_key: String(input || '').trim()
        });
    }

    async _handleMailboxPasswordInput(input, session) {
        const configData = {
            ...session.data,
            mailbox_password: String(input || '').trim()
        };

        if (!configData.username || !configData.password) {
            return new ActionResult(false, STRINGS.username_invalid);
        }

        const validation = await this.validateConfig(configData);
        if (!validation.success) {
            return new ActionResult(false, STRINGS.fail_login + "\n" + (validation.details || ""), null, null, validation.reason);
        }

        return new ActionResult(true, STRINGS.success.replace('{{username}}', configData.username), null, configData);
    }

    async _normalizeSecret(secret, format) {
        return await CloudTool.normalizePasswordForRclone(secret, { format: format || 'plain' });
    }

    async _normalizeOptionalSecret(secret, format) {
        const value = String(secret || '').trim();
        if (!value) return '';
        return await this._normalizeSecret(value, format || 'plain');
    }

    _escapeValue(value) {
        return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}
