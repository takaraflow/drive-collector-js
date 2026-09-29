import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/protondrive.js";
import { logger } from "../logger/index.js";
import { DriveRepository } from "../../repositories/DriveRepository.js";
import {
    normalizeBindingText,
    parseBooleanInput
} from "../../domain/binding-input.js";

const log = logger.withModule ? logger.withModule('ProtonDriveProvider') : logger;

const USE_2FA_CHOICES = Object.freeze([
    { value: 'yes', label: '已开启 2FA' },
    { value: 'no', label: '未开启 2FA' }
]);

const SESSION_KEYS = Object.freeze([
    'client_uid',
    'client_access_token',
    'client_refresh_token',
    'client_salted_key_pass'
]);

/**
 * Proton Drive binding follows a user-facing path, not a raw rclone form dump:
 * username → password → 2FA yes/no → (code, only when 2FA is on).
 *
 * One-time 2FA codes are only for bootstrap login. Durable access comes from rclone session
 * tokens (client_uid / access / refresh / salted key pass) captured after bind.
 */
export class ProtonDriveProvider extends BaseDriveProvider {
    constructor() {
        super('protondrive', 'Proton Drive', {
            supportLevel: 'advanced',
            supportNote: 'Username/password binding with an optional one-time 2FA code. Session tokens are captured after bind for durable access. Backend is beta upstream.'
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
            })
        ];
    }

    getBindingStep(stepName) {
        return super.getBindingStep(stepName);
    }

    isFinalBindingStep(stepName, session = null, input = null) {
        void session;
        // Finality is keyed off the pending input so a step that only sometimes submits does
        // not prematurely trigger the verifying prompt / session-clearing failure path:
        // - WAIT_2FA: terminal only for a well-formed 6-digit code. A malformed/blank code is
        //   rejected in place (non-final), so the user retypes without losing the whole session.
        // - WAIT_USE_2FA: terminal only on "no" (submits now); "yes" advances to WAIT_2FA and
        //   must NOT flash the verifying prompt.
        // Both format checks mirror _handle2faInput / _handleUse2faInput and must stay in sync.
        if (stepName === 'WAIT_2FA') {
            return /^\d{6}$/.test(normalizeBindingText(input));
        }
        if (stepName === 'WAIT_USE_2FA') {
            const parsed = parseBooleanInput(input);
            return parsed.valid && parsed.value === false;
        }
        return false;
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
            default:
                return new ActionResult(false, '未知步骤');
        }
    }

    async validateConfig(configData) {
        try {
            const runtimeConfig = await this.prepareConfigForRuntime(configData);
            log.info('Proton bind validation materials', {
                username: runtimeConfig.username,
                hasPassword: Boolean(runtimeConfig.password),
                passwordFormat: runtimeConfig.password_format,
                twoFactorEnabled: configData.two_factor_enabled === true,
                hasOneTime2fa: Boolean(runtimeConfig.two_factor),
                allowOneTime2fa: runtimeConfig.allow_one_time_2fa === true,
                hasSession: this._hasReusableSession(runtimeConfig)
            });
            const result = await CloudTool.validateConfigWithWritableSession(this.type, runtimeConfig);
            if (!result.success) {
                log.warn('Proton bind validation failed', {
                    reason: result.reason,
                    details: result.details,
                    hasOneTime2fa: Boolean(runtimeConfig.two_factor),
                    allowOneTime2fa: runtimeConfig.allow_one_time_2fa === true,
                    remoteConfigKeys: Object.keys(result.remoteConfig || {})
                });
                return new ValidationResult(false, result.reason, result.details);
            }

            const session = this._extractSessionFromRemoteConfig(result.remoteConfig);
            const hasSession = this._hasReusableSession(session);
            const requiresDurableAuth =
                configData.two_factor_enabled === true ||
                Boolean(normalizeBindingText(configData.two_factor));

            // 2FA accounts must capture rclone session tokens. Without them, later transfers
            // would only have an expired one-time code (or would re-require interactive 2FA).
            if (requiresDurableAuth && !hasSession) {
                return new ValidationResult(
                    false,
                    'SESSION_BOOTSTRAP_FAILED',
                    'login succeeded but durable session tokens were not captured'
                );
            }

            return new ValidationResult(true, null, null, {
                ...configData,
                ...session,
                session_bootstrap_ok: hasSession
            });
        } catch (error) {
            log.error('Proton Drive validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    async prepareConfigForStorage(configData = {}) {
        const session = this._pickSessionFields(configData);

        // Never persist one-time 2FA codes. They expire within ~30s and break later transfers.
        // Also never persist allow_one_time_2fa — that flag is request-scoped only.
        return {
            username: normalizeBindingText(configData.username),
            password: await this._normalizeSecret(configData.password, configData.password_format || 'plain'),
            password_format: 'rclone_obscured',
            two_factor_enabled: configData.two_factor_enabled === true,
            ...session,
            session_bootstrap_ok: this._hasReusableSession(session)
        };
    }

    async prepareConfigForRuntime(configData = {}) {
        // Binding-time credentials are plain. Only persisted configs carry *_format=rclone_obscured.
        // Defaulting missing format to rclone_obscured would skip obscure and make rclone try to
        // decrypt a plain password ("illegal base64 data").
        const passwordFormat = configData.password_format || 'plain';
        // Capture this BEFORE rewriting password_format. After obscure we always mark
        // password_format=rclone_obscured, so later steps must not use that field to decide
        // whether a one-time 2FA code is still valid for this request.
        const allowOneTime2fa =
            configData.allow_one_time_2fa === true ||
            passwordFormat === 'plain';

        const runtime = {
            ...configData,
            username: normalizeBindingText(configData.username),
            password: await this._normalizeSecret(configData.password, passwordFormat),
            password_format: 'rclone_obscured',
            allow_one_time_2fa: allowOneTime2fa
        };

        // One-time 2FA codes are bind-time only (plain credentials). Never replay codes from
        // persisted configs — they expire quickly and cause transfer-time 422 2FA failures.
        if (this._hasReusableSession(runtime) || !allowOneTime2fa) {
            runtime.two_factor = '';
        } else {
            runtime.two_factor = normalizeBindingText(configData.two_factor);
        }

        return runtime;
    }

    /**
     * Ensure runtime config has a reusable Proton session when possible.
     * Used after load so transfers do not re-submit an expired 2FA code.
     */
    async ensureRuntimeSession(configData = {}, context = {}) {
        if (this._hasReusableSession(configData)) {
            return {
                ...configData,
                two_factor: ''
            };
        }

        // Bootstrap login materials:
        // - still-fresh one-time 2FA code (bind-time plain configs only)
        // - password alone for non-2FA accounts
        const hasFreshCode =
            (
                configData.allow_one_time_2fa === true ||
                (configData.password_format || 'plain') === 'plain'
            ) &&
            Boolean(normalizeBindingText(configData.two_factor));
        const non2faAccount = configData.two_factor_enabled !== true && !hasFreshCode;
        const canBootstrap = hasFreshCode || non2faAccount;

        if (!canBootstrap || !normalizeBindingText(configData.username) || !normalizeBindingText(configData.password)) {
            return configData;
        }

        try {
            const cloudTool = context.cloudTool || CloudTool;
            const result = await cloudTool.validateConfigWithWritableSession(this.type, {
                ...configData,
                type: this.type
            });

            if (!result.success) {
                log.warn('Proton session bootstrap failed at runtime', {
                    reason: result.reason,
                    details: result.details
                });
                return configData;
            }

            const session = this._extractSessionFromRemoteConfig(result.remoteConfig);
            if (!this._hasReusableSession(session)) {
                return configData;
            }

            const next = {
                ...configData,
                ...session,
                two_factor: '',
                session_bootstrap_ok: true
            };

            if (context.activeDrive?.id && context.userId) {
                try {
                    const stored = await this.prepareConfigForStorage(next);
                    await DriveRepository.updateConfigData(context.userId, context.activeDrive.id, stored);
                } catch (error) {
                    log.warn('Failed to persist refreshed Proton session', {
                        error: error.message,
                        driveId: context.activeDrive.id
                    });
                }
            }

            return next;
        } catch (error) {
            log.warn('Proton ensureRuntimeSession error', { error: error.message });
            return configData;
        }
    }

    /**
     * Merge session tokens harvested from a temporary rclone conf back into stored config.
     */
    async mergeRuntimeSessionFromRemoteConfig(configData = {}, remoteConfig = {}, context = {}) {
        const session = this._extractSessionFromRemoteConfig(remoteConfig);
        if (!this._hasReusableSession(session)) {
            return null;
        }

        const sameSession = SESSION_KEYS.every((key) => (
            normalizeBindingText(configData[key]) === normalizeBindingText(session[key])
        ));
        if (sameSession) {
            return {
                ...configData,
                ...session,
                two_factor: '',
                session_bootstrap_ok: true
            };
        }

        const next = {
            ...configData,
            ...session,
            two_factor: '',
            session_bootstrap_ok: true
        };

        if (context.userId && context.activeDrive?.id) {
            try {
                const stored = await this.prepareConfigForStorage(next);
                await DriveRepository.updateConfigData(context.userId, context.activeDrive.id, stored);
            } catch (error) {
                log.warn('Failed to persist harvested Proton session', {
                    error: error.message,
                    driveId: context.activeDrive.id
                });
            }
        } else if (context.userId) {
            // Best-effort: resolve default drive if caller only has userId.
            try {
                const drive = await DriveRepository.getDefaultDrive(context.userId);
                if (drive?.id && String(drive.type || '').toLowerCase() === this.type) {
                    const stored = await this.prepareConfigForStorage(next);
                    await DriveRepository.updateConfigData(context.userId, drive.id, stored);
                }
            } catch (error) {
                log.warn('Failed to persist harvested Proton session via default drive', {
                    error: error.message,
                    userId: context.userId
                });
            }
        }

        return next;
    }

    /**
     * Entries written into a temporary named rclone conf for session bootstrap / runtime.
     */
    getWritableRcloneConfigEntries(config = {}) {
        const entries = {
            username: normalizeBindingText(config.username),
            password: normalizeBindingText(config.password)
        };

        if (this._hasReusableSession(config)) {
            for (const key of SESSION_KEYS) {
                entries[key] = normalizeBindingText(config[key]);
            }
            return entries;
        }

        // One-time codes only when prepareConfigForRuntime kept them for this request.
        // IMPORTANT: do not key off password_format here — runtime configs always mark
        // password_format=rclone_obscured after obscure, even during bind-time validation.
        const twoFactor = normalizeBindingText(config.two_factor);
        const allowOneTime2fa =
            config.allow_one_time_2fa === true ||
            (config.password_format || 'plain') === 'plain';
        if (allowOneTime2fa && twoFactor) {
            entries['2fa'] = twoFactor;
        }

        return entries;
    }

    getConnectionString(config = {}) {
        this.assertRequiredConfig(config, ['username', 'password']);
        const segments = [
            `username="${this._escapeValue(config.username)}"`,
            `password="${this._escapeValue(config.password)}"`
        ];

        if (this._hasReusableSession(config)) {
            for (const key of SESSION_KEYS) {
                segments.push(`${key}="${this._escapeValue(config[key])}"`);
            }
        } else {
            // No durable session yet: pass the one-time code only when this request still allows it.
            const allowOneTime2fa =
                config.allow_one_time_2fa === true ||
                (config.password_format || 'plain') === 'plain';
            const twoFactor = normalizeBindingText(config.two_factor);
            if (allowOneTime2fa && twoFactor) {
                segments.push(`2fa="${this._escapeValue(twoFactor)}"`);
            }
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

    async _handleUse2faInput(input, session) {
        const parsed = parseBooleanInput(input);
        if (!parsed.valid) {
            return new ActionResult(false, STRINGS.use_2fa_invalid);
        }

        if (!parsed.value) {
            // No 2FA: nothing left to ask — submit and bind now.
            return this._finalizeBinding({
                ...session.data,
                two_factor_enabled: false,
                two_factor: ''
            });
        }

        return new ActionResult(true, STRINGS.input_2fa_code, 'WAIT_2FA', {
            ...session.data,
            two_factor_enabled: true,
            two_factor: ''
        });
    }

    async _handle2faInput(input, session) {
        const twoFactor = normalizeBindingText(input);
        if (session.data?.two_factor_enabled && !twoFactor) {
            return new ActionResult(false, STRINGS.use_2fa_required);
        }
        if (twoFactor && !/^\d{6}$/.test(twoFactor)) {
            return new ActionResult(false, STRINGS.two_factor_invalid);
        }

        // 2FA branch terminus: submit and bind now.
        return this._finalizeBinding({
            ...session.data,
            two_factor: twoFactor
        });
    }

    /**
     * Validate the assembled config and, on success, return the terminal ActionResult
     * (nextStep=null) so the flow persists the drive. Shared by both bind endpoints:
     * the "no 2FA" answer and the one-time-code step.
     */
    async _finalizeBinding(configData) {
        if (!configData.username || !configData.password) {
            return new ActionResult(false, STRINGS.username_invalid);
        }

        if (configData.two_factor_enabled && !configData.two_factor) {
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

        // Prefer validated payload that may include captured session tokens.
        const finalData = validation.data || configData;

        return new ActionResult(
            true,
            this._formatSuccessMessage(finalData),
            null,
            finalData
        );
    }

    _formatValidationMessage(validation) {
        if (validation.reason === '2FA') {
            return this.getErrorMessage('2FA');
        }
        if (validation.reason === 'SESSION_BOOTSTRAP_FAILED') {
            return STRINGS.fail_session_bootstrap;
        }

        const details = normalizeBindingText(validation.details);
        if (details) {
            return `${STRINGS.fail_login}\n${details}`;
        }
        return STRINGS.fail_login;
    }

    _formatSuccessMessage(configData = {}) {
        const username = normalizeBindingText(configData.username) || 'protondrive';
        if (this._hasReusableSession(configData)) {
            return STRINGS.success_with_session.replace('{{username}}', username);
        }
        return STRINGS.success_without_session.replace('{{username}}', username);
    }

    _extractSessionFromRemoteConfig(remoteConfig = {}) {
        const session = {};
        for (const key of SESSION_KEYS) {
            const value = normalizeBindingText(remoteConfig[key]);
            if (value) session[key] = value;
        }
        return session;
    }

    _pickSessionFields(config = {}) {
        const session = {};
        for (const key of SESSION_KEYS) {
            const value = normalizeBindingText(config[key]);
            if (value) session[key] = value;
        }
        return session;
    }

    _hasReusableSession(config = {}) {
        return SESSION_KEYS.every((key) => Boolean(normalizeBindingText(config[key])));
    }

    /**
     * Recovery for a server-side-dead Proton session (Code=10013): clear the stored session
     * tokens so `_hasReusableSession` turns false and the next transfer re-bootstraps a login
     * instead of feeding the dead refresh_token to rclone forever. Non-2FA accounts self-heal
     * via password; a 2FA account surfaces a clean "please rebind" signal instead of silently
     * looping 10013. Best-effort — never throws into the caller. Username/password are preserved
     * so bootstrap can run.
     */
    async invalidateStoredSession(userId) {
        if (!userId) return false;
        try {
            const drive = await DriveRepository.getDefaultDrive(userId);
            if (!drive?.id || String(drive.type || '').toLowerCase() !== this.type) {
                return false;
            }
            let current;
            try {
                current = JSON.parse(drive.config_data || '{}');
            } catch {
                current = {};
            }
            if (!this._hasReusableSession(current)) {
                return false; // already cleared — avoid a redundant write / re-bootstrap churn
            }
            const cleared = { ...current };
            for (const key of SESSION_KEYS) delete cleared[key];
            cleared.session_bootstrap_ok = false;
            await DriveRepository.updateConfigData(userId, drive.id, cleared);
            log.warn('Cleared dead Proton session after Code=10013; next op will re-bootstrap', {
                userId,
                driveId: drive.id
            });
            return true;
        } catch (error) {
            log.warn('invalidateStoredSession failed', { userId, error: error.message });
            return false;
        }
    }


    async _normalizeSecret(secret, format) {
        return await CloudTool.normalizePasswordForRclone(secret, { format: format || 'plain' });
    }

    _escapeValue(value) {
        return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}
