import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/google_drive.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('GoogleDriveProvider') : logger;

export class GoogleDriveProvider extends BaseDriveProvider {
    constructor() {
        super('drive', 'Google Drive');
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
            log.error('Google Drive validation error:', error);
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
        
        // Compact the JSON to remove whitespace
        const token = JSON.stringify(JSON.parse(input));
        
        const configData = { token };
        
        // Notify user verifying
        // In this architecture, we return action result. 
        // We can't easily send intermediate message "Verifying..." unless the UI layer handles it.
        // STRINGS.verifying is defined but maybe not used here directly in return.
        
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
