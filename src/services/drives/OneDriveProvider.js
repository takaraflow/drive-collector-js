import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/onedrive.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('OneDriveProvider') : logger;

export class OneDriveProvider extends BaseDriveProvider {
    constructor() {
        super('onedrive', 'OneDrive');
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_TOKEN', 'input_token', this._validateToken.bind(this))
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_TOKEN':
                return this._handleTokenInput(input, session);
            default:
                return new ActionResult(false, '未知步骤');
        }
    }

    async validateConfig(configData) {
        try {
            const result = await CloudTool.validateConfig(this.type, configData);
            
            if (result.success) {
                return new ValidationResult(true);
            } else {
                return new ValidationResult(false, result.reason, result.details);
            }
        } catch (error) {
            log.error('OneDrive validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    getErrorMessage(errorType) {
        const errorMessages = {
            'TOKEN_INVALID': STRINGS.fail_token,
            'NETWORK_ERROR': STRINGS.fail_network,
            'UNKNOWN': STRINGS.fail_unknown
        };
        return errorMessages[errorType] || errorMessages['UNKNOWN'];
    }

    getConnectionString(config) {
        // OneDrive often also needs drive_id and drive_type, but token + auto discovery might work for Personal.
        // For Business, might need more. But usually token contains scopes.
        // rclone config usually sets drive_id and drive_type automatically during config.
        // If we just provide token, rclone might complain if it can't choose.
        // But let's try with just token. 
        const token = (config.token || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},token="${token}":`;
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

    async _handleTokenInput(input, session) {
        const validation = this._validateToken(input);
        if (!validation.valid) {
            return new ActionResult(false, validation.message);
        }
        
        const token = JSON.stringify(JSON.parse(input));
        
        const configData = { token };
        const valResult = await this.validateConfig(configData);
        
        if (!valResult.success) {
             return new ActionResult(false, STRINGS.fail_token + "\n\nDetails: " + (valResult.details || "").slice(-100));
        }
        
        return new ActionResult(
            true,
            STRINGS.success,
            null,
            configData
        );
    }
}
