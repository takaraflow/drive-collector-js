import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/pikpak.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('PikPakProvider') : logger;

export class PikPakProvider extends BaseDriveProvider {
    constructor() {
        super('pikpak', 'PikPak', {
            supportLevel: 'advanced',
            supportNote: 'Username/password support depends on the bundled rclone backend and account policy.'
        });
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
            const processedConfig = {
                ...configData,
                pass: await this.processPassword(configData.pass)
            };
            const result = await CloudTool.validateConfig(this.type, processedConfig);
            if (result.success) return new ValidationResult(true);
            return new ValidationResult(false, result.reason, result.details);
        } catch (error) {
            log.error('PikPak validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    async processPassword(password) {
        if (typeof CloudTool.normalizePasswordForRclone === "function") {
            return await CloudTool.normalizePasswordForRclone(password);
        }
        return password;
    }

    getConnectionString(config) {
        this.assertRequiredConfig(config, ['user', 'pass']);
        const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},user="${user}",pass="${pass}":`;
    }
}
