import { AxiomLogger } from './AxiomLogger.js';
import { ConsoleLogger } from './ConsoleLogger.js';

let getInstanceIdFunc = () => 'unknown';
const localFallbackId = `boot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

export const setInstanceIdProvider = (provider) => {
    getInstanceIdFunc = provider;
};

const getSafeInstanceId = () => {
    try {
        const id = getInstanceIdFunc();
        if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
            return id;
        }
        return localFallbackId;
    } catch (e) {
        return localFallbackId;
    }
};

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

let consoleProxyEnabled = false;

export const enableTelegramConsoleProxy = () => {
    if (consoleProxyEnabled) return;

    consoleProxyEnabled = true;

    console.error = (...args) => {
        const msg = args[0]?.toString() || '';
        const msgLower = msg.toLowerCase();

        const isTimeoutPattern =
            msgLower.includes('timeout') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ECONNRESET') ||
            msg.includes('timed out') ||
            msg.includes('TIMEOUT');

        if (isTimeoutPattern) {
            const wrapper = LoggerService.getInstance();
            wrapper.error(`Telegram library TIMEOUT captured: ${msg}`, {
                service: 'telegram',
                source: 'console_proxy',
                args: args.length > 1 ? args.slice(1) : undefined,
                timestamp: Date.now()
            });
        }

        originalConsoleError.call(console, ...args);
    };

    console.warn = (...args) => {
        const msg = args[0]?.toString() || '';

        if (msg.includes('TIMEOUT') || msg.includes('timeout')) {
            const wrapper = LoggerService.getInstance();
            wrapper.warn('Telegram timeout warning captured', {
                message: msg,
                source: 'console_proxy'
            });
        }

        originalConsoleWarn.call(console, ...args);
    };

    console.log = (...args) => {
        const msg = args[0]?.toString() || '';

        if (msg.includes('connected') || msg.includes('disconnected') || msg.includes('connection')) {
            const wrapper = LoggerService.getInstance();
            wrapper.info('Telegram connection event captured', {
                message: msg,
                source: 'console_proxy'
            });
        }

        originalConsoleLog.call(console, ...args);
    };
};

export const disableTelegramConsoleProxy = () => {
    if (!consoleProxyEnabled) return;

    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;
    consoleProxyEnabled = false;
};

export const flushLogBuffer = async (timeoutMs = 10000) => {
    const instance = LoggerService.getInstance();
    await instance.flush(timeoutMs);
};

let _singletonInstance = null;
let _singletonTimestamp = Date.now();

class LoggerService {
    constructor(options = {}) {
        this.options = options;
        this.isInitialized = false;
        this.primaryLogger = null;
        this.fallbackLogger = null;
        this.currentProviderName = 'ConsoleLogger';
        this._baseContext = {};
        this._moduleTimestamp = _singletonTimestamp;
    }

    static getInstance() {
        if (!_singletonInstance) {
            _singletonInstance = new LoggerService();
            _singletonInstance._moduleTimestamp = _singletonTimestamp;
        }
        return _singletonInstance;
    }

    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        try {
            const axiomLogger = new AxiomLogger();
            await axiomLogger.initialize();
            await axiomLogger.connect();

            if (axiomLogger.client) {
                this.primaryLogger = axiomLogger;
                this.currentProviderName = 'AxiomLogger';
            } else {
                this.primaryLogger = null;
            }
        } catch (error) {
            this.primaryLogger = null;
        }

        if (!this.primaryLogger) {
            this.fallbackLogger = new ConsoleLogger();
            await this.fallbackLogger.initialize();
            this.currentProviderName = 'ConsoleLogger';
        }

        this.isInitialized = true;
    }

    _ensureInitialized() {
        if (!this.isInitialized) {
            // 自动初始化，而不是只输出警告
            this.initialize().catch(err => {
                console.error('LoggerService auto-initialization failed:', err.message);
            });
        }
    }

    _getActiveLogger() {
        this._ensureInitialized();
        return this.primaryLogger || this.fallbackLogger;
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

    _getContext() {
        let env = this._baseContext.env;
        if (!env) {
            env = process.env.NODE_ENV || 'unknown';
        }
        return { ...this._baseContext, env, instanceId: getSafeInstanceId() };
    }

    async _log(level, message, data, context) {
        const logger = this._getActiveLogger();
        if (!logger) return;

        const normalizedContext = this._normalizeContext(context);
        const fullContext = { ...this._getContext(), ...normalizedContext };

        try {
            await logger[level](message, data, fullContext);
        } catch (error) {
            console.error(`Logger ${level} failed:`, error.message);
        }
    }

    async info(message, data = {}, context = {}) {
        await this._log('info', message, data, context);
    }

    async warn(message, data = {}, context = {}) {
        await this._log('warn', message, data, context);
    }

    async error(message, data = {}, context = {}) {
        await this._log('error', message, data, context);
    }

    async debug(message, data = {}, context = {}) {
        await this._log('debug', message, data, context);
    }

    withContext(extraContext) {
        const newLogger = LoggerService.getInstance();
        newLogger._baseContext = { ...this._baseContext, ...this._normalizeContext(extraContext) };
        newLogger._initialized = this.isInitialized;
        newLogger.primaryLogger = this.primaryLogger;
        newLogger.fallbackLogger = this.fallbackLogger;
        newLogger.currentProviderName = this.currentProviderName;
        return newLogger;
    }

    withModule(moduleName) {
        return this.withContext({ module: moduleName });
    }

    configure(config) {
    }

    isInitialized() {
        return this.isInitialized;
    }

    canSend(level) {
        return true;
    }

    async flush(timeoutMs = 10000) {
        const logger = this._getActiveLogger();
        if (logger && typeof logger.flush === 'function') {
            await logger.flush(timeoutMs);
        }
    }

    getProviderName() {
        return this.currentProviderName;
    }

    getConnectionInfo() {
        const logger = this._getActiveLogger();
        if (logger) {
            return logger.getConnectionInfo();
        }
        return { provider: 'unknown', connected: false };
    }

    async destroy() {
        _singletonInstance = null;
        _singletonTimestamp = Date.now();
        if (this.primaryLogger) {
            await this.primaryLogger.destroy();
        }
        if (this.fallbackLogger) {
            await this.fallbackLogger.destroy();
        }
    }
}

export { LoggerService };

export const createLogger = () => new LoggerService();

export default new LoggerService();