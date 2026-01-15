import { BaseLogger } from './BaseLogger.js';
import { serializeError, serializeToString, limitFields } from '../../utils/serializer.js';

let getInstanceIdFunc = () => 'unknown';

export const setInstanceIdProvider = (provider) => {
    getInstanceIdFunc = provider;
};

/**
 * NewrelicLogger - New Relic Log API implementation
 * Sends logs to New Relic using their Log API (HTTP POST)
 */
class NewrelicLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.licenseKey = options.licenseKey || process.env.NEW_RELIC_LICENSE_KEY;
        this.region = options.region || process.env.NEW_RELIC_REGION || 'US';
        this.service = options.service || process.env.NEW_RELIC_APP_NAME || 'drive-collector';
        this.logBuffer = [];
        this.batchFlushTimer = null;
        this.isBatchFlushing = false;
        this.BATCH_MAX_SIZE = 500;
        this.BATCH_FLUSH_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 5000;
        this.version = 'unknown';
    }

    _getInstanceId() {
        try {
            const id = getInstanceIdFunc();
            if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
                return id;
            }
        } catch (error) {
            // Silently fail for instance ID retrieval
        }
        return 'unknown';
    }

    async initialize() {
        if (this.isInitialized) return;
        await this._initVersion();
        if (!this.licenseKey) {
            // We don't want to spam console if not configured, but it should be noted
            // console.warn('[NewrelicLogger] License key not configured');
        }
        this.isInitialized = true;
    }

    async _initVersion() {
        if (this.version !== 'unknown') return;
        try {
            if (process.env.APP_VERSION) {
                this.version = process.env.APP_VERSION;
                return;
            }
            const { default: pkg } = await import('../../../package.json', { with: { type: 'json' } });
            this.version = pkg.version || 'unknown';
        } catch (error) {
            // Ignore error
        }
    }

    async _connect() {
        if (!this.licenseKey) {
            this.connected = false;
            return;
        }
        this.connected = true;
    }

    _getLogUrl() {
        return this.region.toUpperCase() === 'EU' 
            ? 'https://log-api.eu.newrelic.com/log/v1' 
            : 'https://log-api.newrelic.com/log/v1';
    }

    async _sendBatch(batch) {
        if (!this.licenseKey || !batch.length) return;

        const url = this._getLogUrl();
        // New Relic Log API format: https://docs.newrelic.com/docs/logs/log-api/introduction-log-api/
        const body = [{
            common: {
                attributes: {
                    service: this.service,
                    env: process.env.NODE_ENV || 'unknown',
                    version: this.version,
                    plugin: 'drive-collector-js'
                }
            },
            logs: batch
        }];

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Api-Key': this.licenseKey
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`New Relic API error: ${response.status} ${errorText}`);
            }
        } catch (error) {
            process.stderr.write(`[NewrelicLogger] Log batch failed: ${error.message}\n`);
            throw error;
        }
    }

    _buildPayload(level, message, data, context, instanceId) {
        let finalData = data;
        if (data && typeof data !== 'object') {
            finalData = { value: data };
        } else if (data instanceof Error) {
            finalData = serializeError(data);
        }

        const messageStr = message instanceof Error ? message.message : String(message);

        const payload = {
            timestamp: Date.now(),
            message: messageStr,
            level: level,
            instanceId: instanceId,
            ...context,
            attributes: {
                details: serializeToString(finalData)
            }
        };

        if (finalData instanceof Error || (finalData && finalData.error instanceof Error)) {
            const errObj = finalData instanceof Error ? finalData : finalData.error;
            payload.error_name = String(errObj.name).substring(0, 100);
            payload.error_message = String(errObj.message).substring(0, 200);
        }

        return limitFields(payload, 100);
    }

    async _queueLog(level, message, data, context, instanceId) {
        if (!this.licenseKey) return false;

        if (!this.connected) {
            await this.connect();
        }

        const payload = this._buildPayload(level, message, data, context, instanceId);
        this.logBuffer.push(payload);

        if (this.logBuffer.length >= this.BATCH_MAX_SIZE) {
            await this._flushLogsBatch();
        } else {
            this._scheduleBatchFlush();
        }
        return true;
    }

    _scheduleBatchFlush() {
        if (this.batchFlushTimer || !this.logBuffer.length) return;

        this.batchFlushTimer = setTimeout(() => {
            this.batchFlushTimer = null;
            this._flushLogsBatch();
        }, this.BATCH_FLUSH_INTERVAL_MS);
    }

    async _flushLogsBatch() {
        if (this.isBatchFlushing || !this.logBuffer.length) return;

        if (this.batchFlushTimer) {
            clearTimeout(this.batchFlushTimer);
            this.batchFlushTimer = null;
        }

        this.isBatchFlushing = true;
        const batch = this.logBuffer;
        this.logBuffer = [];

        try {
            await this._sendBatch(batch);
        } catch (error) {
            // On failure, logs are currently lost to avoid memory leaks
            // In a more robust system, we might retry or persist them
        } finally {
            this.isBatchFlushing = false;
            if (this.logBuffer.length) {
                this._scheduleBatchFlush();
            }
        }
    }

    async info(message, data = {}, context = {}) {
        return this._queueLog('info', message, data, context, this._getInstanceId());
    }

    async warn(message, data = {}, context = {}) {
        return this._queueLog('warn', message, data, context, this._getInstanceId());
    }

    async error(message, data = {}, context = {}) {
        return this._queueLog('error', message, data, context, this._getInstanceId());
    }

    async debug(message, data = {}, context = {}) {
        return this._queueLog('debug', message, data, context, this._getInstanceId());
    }

    async flush(timeoutMs = 10000) {
        if (!this.logBuffer.length && !this.isBatchFlushing) return;
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Log flush timeout')), timeoutMs);
        });

        try {
            await Promise.race([this._flushLogsBatch(), timeoutPromise]);
        } catch (error) {
            process.stderr.write(`[NewrelicLogger] Flush failed: ${error.message}\n`);
        }
    }

    async disconnect() {
        if (this.batchFlushTimer) {
            clearTimeout(this.batchFlushTimer);
            this.batchFlushTimer = null;
        }
        await this.flush();
        this.connected = false;
    }
}

export { NewrelicLogger };
