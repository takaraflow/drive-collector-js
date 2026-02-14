import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/webdav.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('WebDAVProvider') : logger;

export class WebDAVProvider extends BaseDriveProvider {
    constructor() {
        super('webdav', 'WebDAV');
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_URL', 'input_url', this._validateUrl.bind(this)),
            new BindingStep('WAIT_USER', 'input_user'),
            new BindingStep('WAIT_PASS', 'input_pass')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_URL':
                if (!this._validateUrl(input).valid) return new ActionResult(false, STRINGS.url_invalid);
                return new ActionResult(true, STRINGS.input_user, 'WAIT_USER', { url: input.trim() });
                
            case 'WAIT_USER':
                return new ActionResult(true, STRINGS.input_pass, 'WAIT_PASS', { ...session.data, user: input.trim() });
                
            case 'WAIT_PASS':
                const { url, user } = session.data || {};
                if (!url || !user) return new ActionResult(false, 'Missing url or user');
                
                const configData = { url, user, pass: input.trim() };
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
            log.error('WebDAV validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    async processPassword(password) {
        if (typeof CloudTool._obscure === "function") {
            return await CloudTool._obscure(password);
        }
        return password;
    }

    getValidationCommand() {
        return 'lsd';
    }

    getConnectionString(config) {
        const url = (config.url || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        // WebDAV uses 'url', 'user', 'pass' (obscured)
        // vendor is optional, but setting 'other' helps compatibility
        return `:${this.type},url="${url}",user="${user}",pass="${pass}",vendor="other":`;
    }

    _validateUrl(url) {
        if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
            return { valid: false, message: STRINGS.url_invalid };
        }
        return { valid: true };
    }
}
