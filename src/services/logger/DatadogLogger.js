import { BaseLogger } from './BaseLogger.js';

class DatadogLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.apiKey = options.apiKey || process.env.DATADOG_API_KEY;
        this.site = options.site || process.env.DATADOG_SITE || 'datadoghq.com';
        this.service = options.service || 'drive-collector';
        this.version = 'unknown';
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!this.apiKey) {
            console.warn('Datadog API key not configured');
        }
        this.isInitialized = true;
    }

    async _connect() {
        if (!this.apiKey) {
            this.connected = false;
            return;
        }
        this.connected = true;
    }

    async _sendToDatadog(level, message, data, context) {
        const payload = {
            ddsource: 'node',
            ddtags: `env:${process.env.NODE_ENV || 'unknown'},service:${this.service}`,
            hostname: context.instanceId || 'unknown',
            message: message,
            service: this.service,
            status: level,
            timestamp: Date.now() * 1000000,
            version: this.version,
            additional_info: data
        };

        const url = `https://http-intake.logs.${this.site}/v1/input/${this.apiKey}`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([payload])
            });

            if (!response.ok) {
                throw new Error(`Datadog API error: ${response.status}`);
            }
        } catch (error) {
            console.error('Datadog log failed:', error.message);
            throw error;
        }
    }

    async info(message, data = {}, context = {}) {
        await this._sendToDatadog('info', message, data, context);
    }

    async warn(message, data = {}, context = {}) {
        await this._sendToDatadog('warning', message, data, context);
    }

    async error(message, data = {}, context = {}) {
        await this._sendToDatadog('error', message, data, context);
    }

    async debug(message, data = {}, context = {}) {
        await this._sendToDatadog('debug', message, data, context);
    }
}

export { DatadogLogger };
