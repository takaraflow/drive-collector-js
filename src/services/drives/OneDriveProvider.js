import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/onedrive.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('OneDriveProvider') : logger;

export class OneDriveProvider extends BaseDriveProvider {
    constructor() {
        super('onedrive', 'OneDrive', {
            supportLevel: 'advanced',
            supportNote: 'Requires the rclone token plus drive_id and drive_type exported from a configured OneDrive remote.'
        });
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_TOKEN', 'input_token', this._validateToken.bind(this)),
            new BindingStep('WAIT_DRIVE_ID', 'input_drive_id'),
            new BindingStep('WAIT_DRIVE_TYPE', 'input_drive_type')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_TOKEN':
                return this._handleTokenInput(input, session);
            case 'WAIT_DRIVE_ID':
                return this._handleDriveIdInput(input, session);
            case 'WAIT_DRIVE_TYPE':
                return this._handleDriveTypeInput(input, session);
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
        this.assertRequiredConfig(config, ['token', 'drive_id', 'drive_type']);
        const token = (config.token || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const driveId = (config.drive_id || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const driveType = (config.drive_type || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},token="${token}",drive_id="${driveId}",drive_type="${driveType}":`;
    }

    getDisplayAccount(config = {}) {
        return config.drive_id || 'onedrive';
    }

    _validateToken(input) {
        try {
            const json = JSON.parse(input);
            if (!json.access_token || !json.refresh_token) {
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
        
        return new ActionResult(true, STRINGS.input_drive_id, 'WAIT_DRIVE_ID', { token });
    }

    _handleDriveIdInput(input, session) {
        const driveId = input.trim();
        if (!driveId) {
            return new ActionResult(false, STRINGS.drive_id_invalid);
        }
        return new ActionResult(true, STRINGS.input_drive_type, 'WAIT_DRIVE_TYPE', {
            ...session.data,
            drive_id: driveId
        });
    }

    async _handleDriveTypeInput(input, session) {
        const driveType = input.trim();
        if (!['personal', 'business', 'documentLibrary'].includes(driveType)) {
            return new ActionResult(false, STRINGS.drive_type_invalid);
        }

        const configData = {
            ...session.data,
            drive_type: driveType
        };
        if (!configData.token || !configData.drive_id) {
            return new ActionResult(false, STRINGS.token_invalid);
        }

        const valResult = await this.validateConfig(configData);
        if (!valResult.success) {
            return new ActionResult(false, STRINGS.fail_token + "\n\nDetails: " + (valResult.details || "").slice(-100));
        }

        return new ActionResult(true, STRINGS.success, null, configData);
    }
}
