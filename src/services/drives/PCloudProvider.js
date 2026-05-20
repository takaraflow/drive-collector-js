import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/pcloud.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('PCloudProvider') : logger;
const DEFAULT_HOSTNAME = 'api.pcloud.com';

export class PCloudProvider extends BaseDriveProvider {
    constructor() {
        super('pcloud', 'pCloud', {
            supportLevel: 'advanced',
            supportNote: 'Requires the rclone OAuth token exported from a configured pCloud remote.'
        });
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_TOKEN', 'input_token', this._validateToken.bind(this)),
            new BindingStep('WAIT_HOSTNAME', 'input_hostname')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_TOKEN': {
                const validation = this._validateToken(input);
                if (!validation.valid) return new ActionResult(false, validation.message);

                return new ActionResult(true, STRINGS.input_hostname, 'WAIT_HOSTNAME', {
                    token: JSON.stringify(JSON.parse(input))
                });
            }

            case 'WAIT_HOSTNAME': {
                const hostname = this._normalizeHostname(input);
                if (!hostname) return new ActionResult(false, STRINGS.hostname_invalid);

                const configData = {
                    ...session.data,
                    hostname
                };
                if (!configData.token) {
                    return new ActionResult(false, STRINGS.token_invalid);
                }

                const valResult = await this.validateConfig(configData);
                if (!valResult.success) {
                    return new ActionResult(false, STRINGS.fail_token + "\n" + (valResult.details || ""), null, null, valResult.reason);
                }

                return new ActionResult(true, STRINGS.success, null, configData);
            }
            default:
                return new ActionResult(false, 'Unknown step');
        }
    }

    async validateConfig(configData) {
        try {
            const result = await CloudTool.validateConfig(this.type, configData);
            if (result.success) return new ValidationResult(true);
            return new ValidationResult(false, result.reason, result.details);
        } catch (error) {
            log.error('pCloud validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    getConnectionString(config) {
        this.assertRequiredConfig(config, ['token']);
        const token = (config.token || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const hostname = (config.hostname || DEFAULT_HOSTNAME).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},token="${token}",hostname="${hostname}":`;
    }

    getDisplayAccount(config = {}) {
        return config.email || 'token';
    }

    _validateToken(input) {
        try {
            const json = JSON.parse(input);
            if (!json.access_token) {
                return { valid: false, message: STRINGS.token_invalid };
            }
            return { valid: true };
        } catch (e) {
            return { valid: false, message: STRINGS.token_invalid };
        }
    }

    _normalizeHostname(hostname) {
        const value = String(hostname || '').trim();
        if (!value) {
            return DEFAULT_HOSTNAME;
        }
        if (/\s/.test(value) || value.includes('://') || value.includes('/') || value.includes('?') || value.includes('#')) {
            return null;
        }
        return value;
    }
}
