import { Axiom } from '@axiomhq/js';
import { BaseLogger } from './BaseLogger.js';
import { limitFields, serializeError, serializeToString } from '../../utils/serializer.js';
import { getBeijingISOString } from '../../utils/timeUtils.js';

const AXIOM_UNAVAILABLE_BACKOFF_MS = 3 * 1000;

let getInstanceIdFunc = () => 'unknown';

export const setInstanceIdProvider = (provider) => {
    getInstanceIdFunc = provider;
};

class AxiomLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.client = null;
        this.dataset = options.dataset || 'drive-collector';
        this.axiomSuspendedUntil = 0;
        this.logBuffer = [];
        this.batchFlushTimer = null;
        this.isBatchFlushing = false;
        this.BATCH_MAX_SIZE = 500;
        this.BATCH_FLUSH_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 3000;
        this.version = 'unknown';
    }

    _getInstanceId() {
        try {
            const id = getInstanceIdFunc();
            if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
                return id;
            }
        } catch (error) {
            process.stderr.write(`[AxiomLogger] Failed to construct log object: ${error?.message || error}\n`);
        }
        return 'unknown';
    }

    async initialize() {
        if (this.isInitialized) return;
        await this._initVersion();
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
            process.stderr.write(`[AxiomLogger] Failed to send log: ${error?.message || error}\n`);
        }
    }

    async _connect() {
        const envToken = process.env.AXIOM_TOKEN;
        const envOrgId = process.env.AXIOM_ORG_ID;
        const envDataset = process.env.AXIOM_DATASET;

        if (!envToken || !envOrgId) {
            this.client = null;
            return;
        }

        this.client = new Axiom({
            token: envToken,
            orgId: envOrgId,
            onError: (error) => this._handleError(error)
        });

        if (envDataset) {
            this.dataset = envDataset;
        }
    }

    _handleError(error) {
        if (!error) return;
        const message = String(error.message || '').toLowerCase();
        if (message.includes('unavailable')) {
            this.axiomSuspendedUntil = Date.now() + AXIOM_UNAVAILABLE_BACKOFF_MS;
            this.client = null;
        }
        console.error('Axiom ingest error:', message);
    }

    isSuspended() {
        return Date.now() < this.axiomSuspendedUntil;
    }

    async _ingest(payload) {
        if (!this.client || !this.dataset) {
            return false;
        }

        try {
            const result = await this.client.ingest(this.dataset, [payload]);
            if (result && (result.error || result.status === 'error')) {
                throw new Error(result.error || 'Axiom ingest returned error status');
            }
            return true;
        } catch (error) {
            const lowerErrorMessage = String(error.message || '').toLowerCase();
            if (lowerErrorMessage.includes('unavailable')) {
                this.axiomSuspendedUntil = Date.now() + AXIOM_UNAVAILABLE_BACKOFF_MS;
                this.client = null;
            }
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

        const normalizedContext = this._normalizeContext(context);
        const messageStr = message instanceof Error ? message.message : String(message);

        const payload = {
            ...normalizedContext,
            version: this.version,
            instanceId,
            level,
            message: messageStr,
            timestamp: new Date().toISOString(),
            local_time: getBeijingISOString(),
            details: serializeToString(finalData)
        };

        if (finalData instanceof Error || (finalData && finalData.error instanceof Error)) {
            const errObj = finalData instanceof Error ? finalData : finalData.error;
            payload.error_name = String(errObj.name).substring(0, 100);
            payload.error_message = String(errObj.message).substring(0, 200);
        } else if (finalData && finalData.error) {
            payload.error_summary = String(finalData.error).substring(0, 200);
        }

        const finalPayload = limitFields(payload, 50);
        finalPayload._time = finalPayload.timestamp;
        finalPayload.eventId = `${instanceId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        return finalPayload;
    }

    _normalizeContext(context) {
        if (!context) return {};
        if (typeof context === 'string') {
            return { module: context };
        }
        if (typeof context !== 'object') return {};

        const normalized = {};
        for (const [key, value] of Object.entries(context)) {
            if (value === undefined || value === null) continue;
            normalized[key] = value;
        }
        return normalized;
    }

    async _queueLog(level, message, data, context, instanceId) {
        await this._initVersion();

        if (this.isSuspended()) {
            return false;
        }

        if (!this.client) {
            await this.connect();
        }

        if (!this.client) {
            return false;
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
        if (this.batchFlushTimer || !this.logBuffer.length) {
            return;
        }

        this.batchFlushTimer = setTimeout(() => {
            this.batchFlushTimer = null;
            this._flushLogsBatch();
        }, this.BATCH_FLUSH_INTERVAL_MS);
    }

    async _flushLogsBatch() {
        if (this.isBatchFlushing || !this.logBuffer.length) {
            return;
        }

        if (this.batchFlushTimer) {
            clearTimeout(this.batchFlushTimer);
            this.batchFlushTimer = null;
        }

        this.isBatchFlushing = true;
        const batchToSend = this.logBuffer;
        this.logBuffer = [];

        try {
            await this._retryWithDelay(async () => {
                for (const payload of batchToSend) {
                    const success = await this._ingest(payload);
                    if (!success) {
                        throw new Error('Axiom ingest returned falsy');
                    }
                }
            });
        } catch (error) {
            console.error('Axiom batch ingest failed:', error.message);
        } finally {
            this.isBatchFlushing = false;
            if (this.logBuffer.length) {
                this._scheduleBatchFlush();
            }
        }
    }

    async _retryWithDelay(fn, maxRetries = 3) {
        let lastError;
        for (let retries = 0; retries < maxRetries; retries++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const delayMs = process.env.NODE_ENV === 'test' ? 0 : Math.pow(2, retries) * 1000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        throw lastError;
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
        if (!process.env.AXIOM_TOKEN && !this.client) {
            return false;
        }
        return this._queueLog('debug', message, data, context, this._getInstanceId());
    }

    async flush(timeoutMs = 10000) {
        if (!this.logBuffer.length && !this.isBatchFlushing) {
            return;
        }

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Log flush timeout')), timeoutMs);
        });

        try {
            await Promise.race([this._flushLogsBatch(), timeoutPromise]);
            if (this.logBuffer.length > 0) {
                await Promise.race([this._flushLogsBatch(), timeoutPromise]);
            }
        } catch (error) {
            console.error('Log flush failed:', error.message);
        }
    }

    async disconnect() {
        if (this.batchFlushTimer) {
            clearTimeout(this.batchFlushTimer);
            this.batchFlushTimer = null;
        }
        await this.flush();
        this.connected = false;
        this.client = null;
    }
}

export { AxiomLogger };
