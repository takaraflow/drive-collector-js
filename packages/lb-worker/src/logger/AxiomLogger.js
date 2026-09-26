import { BaseLogger } from './BaseLogger.js';
import { getByteSize } from './byteSize.js';
import { resolveBuildVersion } from './version.js';

const AXIOM_UNAVAILABLE_BACKOFF_MS = 3 * 1000;

let getInstanceIdFunc = () => 'unknown';

export const setInstanceIdProvider = (provider) => {
    getInstanceIdFunc = provider;
};

class AxiomLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.client = null;
        this.dataset = options.dataset || 'lb-worker-js';
        this.axiomSuspendedUntil = 0;
        this.logBuffer = [];
        this.batchFlushTimer = null;
        this.isBatchFlushing = false;
        this.BATCH_MAX_SIZE = 500;
        this.BATCH_FLUSH_INTERVAL_MS = 3000; // CF Workers typically have shorter lifecycles
        this.version = resolveBuildVersion();
    }

    _getInstanceId() {
        try {
            const id = getInstanceIdFunc();
            if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
                return id;
            }
        } catch (error) {
            // CF Worker safe error logging
            try {
                console.error(`[AxiomLogger] Failed to get instance ID: ${error?.message || error}`);
            } catch {
                // 最后的手段
            }
        }
        return 'unknown';
    }

    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;
    }

    async _connect() {
        // In CF Workers, we don't create a persistent client
        // Instead, we check if we have the required configuration
        const hasToken = this.options.token || (typeof globalThis !== 'undefined' && globalThis.AXIOM_TOKEN);
        const hasDataset = this.options.dataset || (typeof globalThis !== 'undefined' && globalThis.AXIOM_DATASET);
        
        if (!hasToken || !hasDataset) {
            this.client = null;
            return;
        }

        // Store configuration for later use
        this.token = this.options.token || globalThis.AXIOM_TOKEN;
        this.dataset = this.options.dataset || globalThis.AXIOM_DATASET || this.dataset;
        this.orgId = this.options.orgId || globalThis.AXIOM_ORG_ID;
        
        // Mark as connected since we have the config
        this.client = {}; // Placeholder to indicate we're "connected"
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
        // Check if we have required configuration
        const token = this.token || (typeof globalThis !== 'undefined' && globalThis.AXIOM_TOKEN);
        const dataset = this.dataset || (typeof globalThis !== 'undefined' && globalThis.AXIOM_DATASET);
        
        if (!token || !dataset) {
            return false;
        }

        try {
            const url = `https://api.axiom.co/v1/datasets/${dataset}/ingest`;
            
            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'cf-worker-custom-logger/1.0'
            };

            // If we have Org ID, add it
            const orgId = this.orgId || (typeof globalThis !== 'undefined' && globalThis.AXIOM_ORG_ID);
            if (orgId) {
                headers['X-Axiom-Org-Id'] = orgId;
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify([payload])
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Axiom ingest failed: Status ${response.status} - ${errText}`);
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

    async ingestBatch(logs, timeoutMs = 10000) {
        const token = this.token || this.options.token || (typeof globalThis !== 'undefined' && globalThis.AXIOM_TOKEN);
        const dataset = this.dataset || this.options.dataset || (typeof globalThis !== 'undefined' && globalThis.AXIOM_DATASET);
        if (!token || !dataset) return false;

        const url = `https://api.axiom.co/v1/datasets/${dataset}/ingest`;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'cf-worker-custom-logger/1.0'
        };

        const orgId = this.orgId || this.options.orgId || (typeof globalThis !== 'undefined' && globalThis.AXIOM_ORG_ID);
        if (orgId) {
            headers['X-Axiom-Org-Id'] = orgId;
        }

        const payloads = Array.isArray(logs) ? logs.slice() : [];
        if (payloads.length === 0) return true;

        // Axiom ingest safeguard: keep body <= 2MB
        const MAX_BODY_BYTES = 2 * 1024 * 1024;
        let batch = payloads.map((entry) => {
            if (!entry || typeof entry !== 'object') return { value: entry };
            if (entry._time) return entry;
            if (entry.timestamp) return { ...entry, _time: entry.timestamp };
            return entry;
        });

        let body = JSON.stringify(batch);
        while (batch.length > 1 && getByteSize(body) > MAX_BODY_BYTES) {
            batch = batch.slice(0, Math.max(1, Math.floor(batch.length * 0.8)));
            body = JSON.stringify(batch);
        }

        if (getByteSize(body) > MAX_BODY_BYTES) {
            // Single event still too large, drop it.
            return false;
        }

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller
            ? setTimeout(() => {
                try {
                    controller.abort();
                } catch {
                    // ignore
                }
            }, timeoutMs)
            : null;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                ...(controller ? { signal: controller.signal } : {})
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error(`[Axiom] Upload failed: ${response.status} ${errText}`);
            }

            return response.ok;
        } catch (error) {
            console.error(`[Axiom] Network Error: ${error?.message || error}`);
            return false;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    _buildPayload(level, message, data, context, instanceId) {
        let finalData = data;
        if (data && typeof data !== 'object') {
            finalData = { value: data };
        } else if (data instanceof Error) {
            finalData = this._serializeError(data);
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
            details: this._serializeToString(finalData)
        };

        if (finalData instanceof Error || (finalData && finalData.error instanceof Error)) {
            const errObj = finalData instanceof Error ? finalData : finalData.error;
            payload.error_name = String(errObj.name).substring(0, 100);
            payload.error_message = String(errObj.message).substring(0, 200);
        } else if (finalData && finalData.error) {
            payload.error_summary = String(finalData.error).substring(0, 200);
        }

        const finalPayload = this._limitFields(payload, 50);
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

    _limitFields(obj, maxFields = 200) {
        if (!obj || typeof obj !== 'object') return obj;
        
        const result = {};
        let count = 0;
        
        for (const key in obj) {
            if (count >= maxFields) {
                result._truncated = true;
                break;
            }
            
            if (obj.hasOwnProperty(key)) {
                result[key] = obj[key];
                count++;
            }
        }
        
        return result;
    }

    _serializeError(err) {
        if (!(err instanceof Error)) return err;
        const serialized = {
            name: err.name,
            message: err.message,
            stack: err.stack,
        };
        // Add any additional enumerable properties
        for (const key in err) {
            if (err.hasOwnProperty(key) && !(key in serialized)) {
                serialized[key] = err[key];
            }
        }
        return serialized;
    }

    _serializeToString(data) {
        // Handle special primitive values
        if (data === undefined) return '{"value":"undefined"}';
        if (typeof data === 'function') return '{"value":"[Function]"}';
        if (typeof data === 'symbol') return `{"value":"${String(data)}"}`;
        
        // Limit depth and fields
        const pruned = this._pruneData(data, 2, 5, 0, new Set());
        
        try {
            return JSON.stringify(pruned, (key, value) => {
                // BigInt handling
                if (typeof value === 'bigint') {
                    return value.toString() + 'n';
                }
                return value;
            });
        } catch (e) {
            return JSON.stringify({
                error: '[Stringify failed]',
                reason: e.message,
                type: typeof data
            });
        }
    }

    _pruneData(obj, maxDepth = 2, maxKeys = 5, currentDepth = 0, seenKeys = new Set()) {
        if (currentDepth >= maxDepth) {
            if (typeof obj === 'object' && obj !== null) {
                return '[Truncated: Max Depth]';
            }
            return obj;
        }
        
        if (obj === null || typeof obj !== 'object') return obj;
        
        // Simple circular reference detection (CF Worker safe)
        // Using a simpler approach since WeakSet is not always available in all environments
        const objKey = typeof obj === 'object' && obj !== null ? JSON.stringify(Object.keys(obj).sort()) : null;
        if (objKey && seenKeys.has(objKey)) {
            return '[Circular Reference]';
        }
        if (objKey) {
            seenKeys.add(objKey);
        }
        
        if (Array.isArray(obj)) {
            // More strict array handling: keep at most 5 items
            const prunedArray = obj.slice(0, maxKeys).map(item => 
                this._pruneData(item, maxDepth, maxKeys, currentDepth + 1, seenKeys)
            );
            if (obj.length > maxKeys) {
                prunedArray.push(`[Truncated: ${obj.length - maxKeys} items]`);
            }
            return prunedArray;
        }

        // Error object special handling
        if (obj instanceof Error) {
            const serialized = this._serializeError(obj);
            return this._pruneData(serialized, maxDepth, maxKeys, currentDepth, seenKeys);
        }

        const newObj = {};
        let keyCount = 0;
        
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                if (keyCount >= maxKeys) {
                    newObj['_truncated'] = `... ${Object.keys(obj).length - maxKeys} more keys`;
                    break;
                }
                newObj[key] = this._pruneData(obj[key], maxDepth, maxKeys, currentDepth + 1, seenKeys);
                keyCount++;
            }
        }
        return newObj;
    }

    async _queueLog(level, message, data, context, instanceId) {
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

        // CF Worker compatible timer
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
                // Send logs one by one in CF Workers environment
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
                // Exponential backoff with max 8 seconds
                const delayMs = Math.min(Math.pow(2, retries) * 1000, 8000);
                // CF Worker compatible sleep
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
        // Only send debug logs if we have explicit configuration
        const token = this.token || (typeof globalThis !== 'undefined' && globalThis.AXIOM_TOKEN);
        if (!token && !this.client) {
            return false;
        }
        return this._queueLog('debug', message, data, context, this._getInstanceId());
    }

    async flush(timeoutMs = 10000) {
        if (!this.logBuffer.length && !this.isBatchFlushing) {
            return;
        }

        // CF Worker compatible timeout
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
