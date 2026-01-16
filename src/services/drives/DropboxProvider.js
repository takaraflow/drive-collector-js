import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/dropbox.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('DropboxProvider') : logger;

export class DropboxProvider extends BaseDriveProvider {
    constructor() {
        super('dropbox', 'Dropbox');
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_TOKEN', 'input_token', this._validateToken.bind(this))
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_TOKEN':
                const validation = this._validateToken(input);
                if (!validation.valid) return new ActionResult(false, validation.message);

                const token = JSON.stringify(JSON.parse(input));
                const configData = { token };
                
                const valResult = await this.validateConfig(configData);
                if (!valResult.success) {
                    return new ActionResult(false, STRINGS.fail_token + "\n" + (valResult.details || ""));
                }
                
                return new ActionResult(true, STRINGS.success, null, configData);
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
            log.error('Dropbox validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    getConnectionString(config) {
        const token = (config.token || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},token="${token}":`;
    }

    _validateToken(input) {
        try {
            const json = JSON.parse(input);
            if (!json.access_token && !json.refresh_token) {
                 // Accept if either exists, though usually full object is best
                return { valid: false, message: STRINGS.token_invalid };
            }
            return { valid: true };
        } catch (e) {
            return { valid: false, message: STRINGS.token_invalid };
        }
    }
}
