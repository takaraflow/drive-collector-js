import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/oss.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('OSSProvider') : logger;

export class OSSProvider extends BaseDriveProvider {
    constructor() {
        super('oss', 'Aliyun OSS');
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_ENDPOINT', 'input_endpoint'),
            new BindingStep('WAIT_AK', 'input_ak'),
            new BindingStep('WAIT_SK', 'input_sk')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_ENDPOINT':
                return new ActionResult(true, STRINGS.input_ak, 'WAIT_AK', { endpoint: input.trim() });
            
            case 'WAIT_AK':
                return new ActionResult(true, STRINGS.input_sk, 'WAIT_SK', { ...session.data, ak: input.trim() });
                
            case 'WAIT_SK':
                const { endpoint, ak } = session.data || {};
                if (!endpoint || !ak) return new ActionResult(false, 'Missing endpoint or AK');
                
                const configData = { endpoint, ak, sk: input.trim() };
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
            // Use 'lsd' instead of 'about' because S3 root usually doesn't support quota check (about),
            // but usually supports listing buckets (lsd).
            const result = await CloudTool.validateConfig(this.type, configData, "lsd");
            
            if (result.success) return new ValidationResult(true);
            return new ValidationResult(false, result.reason, result.details);
        } catch (error) {
            log.error('OSS validation error:', error);
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
        const endpoint = (config.endpoint || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const ak = (config.ak || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const sk = (config.sk || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        
        // Rclone S3 with Alibaba provider
        // Note: We ignore config.type ('oss') and use 's3'
        return `:s3,provider="Alibaba",endpoint="${endpoint}",access_key_id="${ak}",secret_access_key="${sk}":`;
    }
}
