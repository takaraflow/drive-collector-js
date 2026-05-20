import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from "./BaseDriveProvider.js";
import { CloudTool } from "../rclone.js";
import { STRINGS } from "../../locales/drives/oss.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('OSSProvider') : logger;

export class OSSProvider extends BaseDriveProvider {
    constructor() {
        super('oss', 'S3 / OSS', {
            supportLevel: 'advanced',
            supportNote: 'Requires endpoint, bucket, access key, and secret key.'
        });
    }

    getBindingSteps() {
        return [
            new BindingStep('WAIT_ENDPOINT', 'input_endpoint'),
            new BindingStep('WAIT_BUCKET', 'input_bucket'),
            new BindingStep('WAIT_AK', 'input_ak'),
            new BindingStep('WAIT_SK', 'input_sk')
        ];
    }

    async handleInput(step, input, session) {
        switch (step) {
            case 'WAIT_ENDPOINT': {
                const endpoint = this._normalizeEndpoint(input);
                if (!endpoint) return new ActionResult(false, STRINGS.endpoint_invalid);
                return new ActionResult(true, STRINGS.input_bucket, 'WAIT_BUCKET', { endpoint });
            }

            case 'WAIT_BUCKET': {
                if (!this._validateBucket(input).valid) return new ActionResult(false, STRINGS.bucket_invalid);
                return new ActionResult(true, STRINGS.input_ak, 'WAIT_AK', { ...session.data, bucket: input.trim() });
            }
            
            case 'WAIT_AK': {
                return new ActionResult(true, STRINGS.input_sk, 'WAIT_SK', { ...session.data, ak: input.trim() });
            }
                
            case 'WAIT_SK': {
                const { endpoint, bucket, ak } = session.data || {};
                if (!endpoint || !bucket || !ak) return new ActionResult(false, 'Missing endpoint, bucket or AK');
                
                const configData = { endpoint, bucket, ak, sk: input.trim() };
                const validation = await this.validateConfig(configData);
                
                if (!validation.success) {
                    return new ActionResult(false, STRINGS.fail_login + "\n" + (validation.details || ""), null, null, validation.reason);
                }
                
                return new ActionResult(true, STRINGS.success, null, configData);
            }
            default:
                return new ActionResult(false, 'Unknown step');
        }
    }

    async validateConfig(configData) {
        try {
            const result = await CloudTool.validateConfig(this.type, configData, "lsf");
            
            if (result.success) return new ValidationResult(true);
            return new ValidationResult(false, result.reason, result.details);
        } catch (error) {
            log.error('OSS validation error:', error);
            return new ValidationResult(false, 'ERROR', error.message);
        }
    }

    getValidationCommand() {
        return 'lsf';
    }

    getConnectionString(config) {
        this.assertRequiredConfig(config, ['endpoint', 'bucket', 'ak', 'sk']);
        const endpoint = (config.endpoint || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const bucket = (config.bucket || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const ak = (config.ak || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const sk = (config.sk || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        return `:s3,provider="Other",endpoint="${endpoint}",access_key_id="${ak}",secret_access_key="${sk}":${bucket}`;
    }

    getDisplayAccount(config = {}) {
        return config.bucket || config.endpoint || 'bucket';
    }

    _normalizeEndpoint(endpoint) {
        const value = String(endpoint || '').trim();
        if (!value || /\s/.test(value)) {
            return null;
        }

        if (/^https?:\/\//i.test(value)) {
            try {
                const url = new URL(value);
                if (url.username || url.password || url.search || url.hash) {
                    return null;
                }
                if (url.pathname && url.pathname !== '/') {
                    return null;
                }
                return url.origin;
            } catch {
                return null;
            }
        }

        if (value.includes('://') || value.includes('/') || value.includes('?') || value.includes('#')) {
            return null;
        }

        return value;
    }

    _validateEndpoint(endpoint) {
        return this._normalizeEndpoint(endpoint)
            ? { valid: true }
            : { valid: false, message: STRINGS.endpoint_invalid };
    }

    _validateBucket(bucket) {
        const value = String(bucket || '').trim();
        if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) {
            return { valid: false, message: STRINGS.bucket_invalid };
        }
        if (value.includes('..') || value.includes('.-') || value.includes('-.')) {
            return { valid: false, message: STRINGS.bucket_invalid };
        }
        return { valid: true };
    }
}
