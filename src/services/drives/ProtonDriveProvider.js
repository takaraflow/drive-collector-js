import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/protondrive.js";
import { logger } from "../logger/index.js";
import {
    normalizeBindingText,
    normalizeOptionalBindingInput,
    parseBooleanInput
} from "../../domain/binding-input.js";

const log = logger.withModule ? logger.withModule('ProtonDriveProvider') : logger;

const USE_2FA_CHOICES = Object.freeze([
    { value: 'yes', label: '已开启 2FA' },
    { value: 'no', label: '未开启 2FA' }
]);

/**
 * Proton Drive binding follows a user-facing path, not a raw rclone form dump:
 * username → password → 2FA yes/no → (code) → optional long-term OTP secret → optional mailbox password.
 */
export class ProtonDriveProvider extends BaseDriveProvider {
    constructor() {
        super('protondrive', 'Proton Drive', {
            supportLevel: 'advanced',
            supportNote: 'Username/password binding with optional one-time 2FA code, optional long-term TOTP secret, and optional mailbox password. Backend is beta upstream.'
        });
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_USERNAME', 'input_username', this._validateUsername.bind(this), {
                sensitive: false
            }),
            new BindingStep('WAIT_PASSWORD', 'input_password', null, {
                sensitive: true
            }),
            new BindingStep('WAIT_USE_2FA', 'input_use_2fa', this._validateBoolean.bind(this), {
                sensitive: false,
                choices: USE_2FA_CHOICES
            }),
            new BindingStep('WAIT_2FA', 'input_2fa_code', null, {
                sensitive: true
            }),
            new BindingStep('WAIT_OTP_SECRET_KEY', 'input_otp_secret_key_optional', null, {
                optional: true,
                sensitive: true
            }),
            new BindingStep('WAIT_MAILBOX_PASSWORD', 'input_mailbox_password_optional', null, {
                optional: true,
                sensitive: true
            })
        ];
    }

    getBindingStep(stepName) {
        return super.getBindingStep(stepName);
    }

    isFinalBindingStep(stepName) {
        return stepName === 'WAIT_MAILBOX_PASSWORD';
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
        const otpSecretKey = await this._normalizeOptionalSecret(
            configData.otp_secret_key,
            configData.otp_secret_key_format
        );
        const mailboxPassword = await this._normalizeOptionalSecret(
            configData.mailbox_password,
            configData.mailbox_password_format
        );

        return {
            username: normalizeBindingText(configData.username),
            password: await this._normalizeSecret(configData.password, configData.password_format),
            password_format: 'rclone_obscured',
            two_factor: normalizeBindingText(configData.two_factor),
            two_factor_enabled: configData.two_factor_enabled === true,
            otp_secret_key: otpSecretKey,
            otp_secret_key_format: otpSecretKey ? 'rclone_obscured' : null,
            mailbox_password: mailboxPassword,
            mailbox_password_format: mailboxPassword ? 'rclone_obscured' : null
        };
    }

    async prepareConfigForRuntime(configData = {}) {
        const runtime = {
            ...configData,
            username: normalizeBindingText(configData.username),
            password: await this._normalizeSecret(
                configData.password,
                configData.password_format || 'rclone_obscured'
            ),
            password_format: 'rclone_obscured',
            two_factor: normalizeBindingText(configData.two_factor)
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

        const twoFactor = normalizeBindingText(config.two_factor);
        if (twoFactor) {
            segments.push(`2fa="${this._escapeValue(twoFactor)}"`);
        }

        const otpSecretKey = normalizeBindingText(config.otp_secret_key);
        if (otpSecretKey) {
            segments.push(`otp_secret_key="${this._escapeValue(otpSecretKey)}"`);
        }

        const mailboxPassword = normalizeBindingText(config.mailbox_password);
        if (mailboxPassword) {
            segments.push(`mailbox_password="${this._escapeValue(mailboxPassword)}"`);
        }

        return `:protondrive,${segments.join(',')}:`;
    }

    getDisplayAccount(config = {}) {
        return config.username || 'protondrive';
    }

    getErrorMessage(errorType) {
        const errorMessages = {
            '2FA': STRINGS.fail_2fa,
            'LOGIN_FAILED': STRINGS.fail_login,
            'NETWORK_ERROR': STRINGS.fail_network,
            'UNKNOWN': STRINGS.fail_unknown
        };
        return errorMessages[errorType] || errorMessages.UNKNOWN;
    }

    _validateUsername(username) {
        if (!normalizeBindingText(username)) {
            return { valid: false, message: STRINGS.username_invalid };
        }
        return { valid: true };
    }

    _validateBoolean(input) {
        const parsed = parseBooleanInput(input);
        if (!parsed.valid) {
            return { valid: false, message: STRINGS.use_2fa_invalid };
        }
        return { valid: true };
    }

    _handleUsernameInput(input) {
        const validation = this._validateUsername(input);
        if (!validation.valid) {
            return new ActionResult(false, validation.message);
        }
        return new ActionResult(true, STRINGS.input_password, 'WAIT_PASSWORD', {
            username: normalizeBindingText(input)
        });
    }

    _handlePasswordInput(input, session) {
        const password = normalizeBindingText(input);
        if (!password) {
            return new ActionResult(false, STRINGS.password_invalid);
        }
        return new ActionResult(true, STRINGS.input_use_2fa, 'WAIT_USE_2FA', {
            ...session.data,
            password
        });
    }

    _handleUse2faInput(input, session) {
        const parsed = parseBooleanInput(input);
        if (!parsed.valid) {
            return new ActionResult(false, STRINGS.use_2fa_invalid);
        }

        if (!parsed.value) {
            return new ActionResult(true, STRINGS.input_mailbox_password_optional, 'WAIT_MAILBOX_PASSWORD', {
                ...session.data,
                two_factor_enabled: false,
                two_factor: '',
                otp_secret_key: ''
            });
        }

        return new ActionResult(true, STRINGS.input_2fa_code, 'WAIT_2FA', {
            ...session.data,
            two_factor_enabled: true,
            two_factor: '',
            otp_secret_key: ''
        });
    }

    _handle2faInput(input, session) {
        const twoFactor = normalizeBindingText(input);
        if (session.data?.two_factor_enabled && !twoFactor) {
            return new ActionResult(false, STRINGS.use_2fa_required);
        }
        if (twoFactor && !/^\d{6}$/.test(twoFactor)) {
            return new ActionResult(false, STRINGS.two_factor_invalid);
        }

        return new ActionResult(true, STRINGS.input_otp_secret_key_optional, 'WAIT_OTP_SECRET_KEY', {
            ...session.data,
            two_factor: twoFactor
        });
    }

    _handleOtpSecretInput(input, session) {
        const otpSecretKey = normalizeOptionalBindingInput(input);
        return new ActionResult(true, STRINGS.input_mailbox_password_optional, 'WAIT_MAILBOX_PASSWORD', {
            ...session.data,
            otp_secret_key: otpSecretKey
        });
    }

    async _handleMailboxPasswordInput(input, session) {
        const configData = {
            ...session.data,
            mailbox_password: normalizeOptionalBindingInput(input)
        };

        if (!configData.username || !configData.password) {
            return new ActionResult(false, STRINGS.username_invalid);
        }

        if (configData.two_factor_enabled && !configData.two_factor && !configData.otp_secret_key) {
            return new ActionResult(false, STRINGS.use_2fa_required);
        }

        const validation = await this.validateConfig(configData);
        if (!validation.success) {
            return new ActionResult(
                false,
                this._formatValidationMessage(validation),
                null,
                null,
                validation.reason
            );
        }

        return new ActionResult(
            true,
            STRINGS.success.replace('{{username}}', configData.username),
            null,
            configData
        );
    }

    _formatValidationMessage(validation) {
        if (validation.reason === '2FA') {
            return this.getErrorMessage('2FA');
        }

        const details = normalizeBindingText(validation.details);
        if (details) {
            return `${STRINGS.fail_login}\n${details}`;
        }
        return STRINGS.fail_login;
    }

    async _normalizeSecret(secret, format) {
        return await CloudTool.normalizePasswordForRclone(secret, { format: format || 'plain' });
    }

    async _normalizeOptionalSecret(secret, format) {
        const value = normalizeBindingText(secret);
        if (!value) return '';
        return await this._normalizeSecret(value, format || 'plain');
    }

    _escapeValue(value) {
        return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}
