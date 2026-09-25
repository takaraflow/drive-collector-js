import { AxiomLogger } from './AxiomLogger.js';
import { baseLoggerConfig } from './baseConfig.js';

let _singletonInstance = null;
let _singletonTimestamp = Date.now();

class LoggerService {
    constructor(options = {}) {
        this.options = options;
        this._isInitialized = false;
        this._axiomLogger = null;
        this._currentProviderName = 'none';
        this._configKey = '';
        this._moduleTimestamp = _singletonTimestamp;
    }

    static getInstance() {
        if (!_singletonInstance) {
            _singletonInstance = new LoggerService();
            _singletonInstance._moduleTimestamp = _singletonTimestamp;
        }
        return _singletonInstance;
    }

    async initialize(env = {}) {
        const token = env.AXIOM_TOKEN || baseLoggerConfig.token || (typeof globalThis !== 'undefined' ? globalThis.AXIOM_TOKEN : null);
        const dataset = env.AXIOM_DATASET || baseLoggerConfig.dataset || (typeof globalThis !== 'undefined' ? globalThis.AXIOM_DATASET : null);
        const orgId = env.AXIOM_ORG_ID || baseLoggerConfig.orgId || (typeof globalThis !== 'undefined' ? globalThis.AXIOM_ORG_ID : null);

        const normalizedToken = token ? String(token).trim() : '';
        const normalizedDataset = dataset ? String(dataset).trim() : '';
        const configKey = `${normalizedToken}::${normalizedDataset}::${orgId ? String(orgId).trim() : ''}`;

        if (this._isInitialized && this._configKey === configKey) return;

        this._configKey = configKey;
        this._axiomLogger = null;
        this._currentProviderName = 'none';

        if (normalizedToken && normalizedDataset) {
            try {
                const axiomLogger = new AxiomLogger({ token: normalizedToken, dataset: normalizedDataset, orgId });
                await axiomLogger.initialize();
                await axiomLogger.connect();
                this._axiomLogger = axiomLogger;
                this._currentProviderName = axiomLogger.getProviderName();
            } catch {
                this._axiomLogger = null;
                this._currentProviderName = 'none';
            }
        }

        this._isInitialized = true;
    }

    isInitialized() {
        return this._isInitialized;
    }

    getProviderName() {
        return this._currentProviderName;
    }

    getConnectionInfo() {
        if (this._axiomLogger) {
            return { providers: [this._axiomLogger.getConnectionInfo()] };
        }
        return { providers: [] };
    }

    async flushLogBuffer(logBuffer, timeoutMs = 10000, env = {}) {
        await this.initialize(env);
        if (!logBuffer || (Array.isArray(logBuffer) && logBuffer.length === 0)) return;

        try {
            if (this._axiomLogger) {
                await this._axiomLogger.ingestBatch(logBuffer, timeoutMs);
            }
        } catch (error) {
            try {
                console.error('LoggerService flushLogBuffer failed:', error?.message || error);
            } catch {
                // ignore
            }
        } finally {
            if (Array.isArray(logBuffer) && logBuffer.length > 0) {
                logBuffer.length = 0;
            } else if (logBuffer && typeof logBuffer.clear === 'function') {
                logBuffer.clear();
            }
        }
    }

    async destroy() {
        _singletonInstance = null;
        _singletonTimestamp = Date.now();
        if (this._axiomLogger && typeof this._axiomLogger.destroy === 'function') {
            await this._axiomLogger.destroy();
        }
        this._axiomLogger = null;
        this._isInitialized = false;
    }
}

export { LoggerService };

export const createLogger = () => new LoggerService();

export default LoggerService.getInstance();
