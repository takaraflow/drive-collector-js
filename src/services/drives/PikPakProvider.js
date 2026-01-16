import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/pikpak.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('PikPakProvider') : logger;

export class PikPakProvider extends BaseDriveProvider {
    constructor() {
        super('pikpak', 'PikPak');
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_USER', 'input_user'),
            new BindingStep('WAIT_PASS', 'input_pass')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_USER':
                return new ActionResult(true, STRINGS.input_pass, 'WAIT_PASS', { user: input.trim() });
            case 'WAIT_PASS':
                const user = session.data?.user;
                if (!user) return new ActionResult(false, 'Missing user');
                
                const configData = { user, pass: input.trim() };
                const validation = await this.validateConfig(configData);
                
                if (!validation.success) {
                    return new ActionResult(false, STRINGS.fail_login + "\n" + (validation.details || ""), null, null, validation.reason);
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
            log.error('PikPak validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    processPassword(password) {
        if (typeof CloudTool._obscure === "function") {
            return CloudTool._obscure(password);
        }
        return password;
    }

    getConnectionString(config) {
        const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},user="${user}",pass="${pass}":`;
    }
}
