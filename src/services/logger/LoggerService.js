import { AxiomLogger } from './AxiomLogger.js';
import { NewrelicLogger } from './NewrelicLogger.js';
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
        this.activeLoggers = [];
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
        this.activeLoggers = [];

        // Try Axiom
        try {
            const axiomLogger = new AxiomLogger();
            await axiomLogger.initialize();
            await axiomLogger.connect();

            if (axiomLogger.client) {
                this.activeLoggers.push(axiomLogger);
            }
        } catch (error) {
            // Ignore error
        }

        // Try New Relic
        try {
            const nrLogger = new NewrelicLogger();
            await nrLogger.initialize();
            await nrLogger.connect();

            if (nrLogger.licenseKey) {
                this.activeLoggers.push(nrLogger);
            }
        } catch (error) {
            // Ignore error
        }

        const hasExternalLoggers = this.activeLoggers.length > 0;

        // 始终添加 ConsoleLogger
        // 如果有外部 Logger (Axiom/NewRelic)，开启智能过滤 (smartFilter: true)
        // 这样控制台只显示关键日志，避免刷屏，而详细日志发送到云端
        const consoleLogger = new ConsoleLogger({
            smartFilter: hasExternalLoggers
        });
        await consoleLogger.initialize();
        this.activeLoggers.push(consoleLogger);

        this.currentProviderName = this.activeLoggers.map(l => l.getProviderName()).join('+');
        this.isInitialized = true;
    }

    _ensureInitialized() {
        if (!this.isInitialized) {
            this.initialize().catch(err => {
                console.error('LoggerService auto-initialization failed:', err.message);
            });
        }
    }

    _getLoggers() {
        this._ensureInitialized();
        return this.activeLoggers;
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
        const loggers = this._getLoggers();
        if (!loggers || loggers.length === 0) return;

        const normalizedContext = this._normalizeContext(context);
        const fullContext = { ...this._getContext(), ...normalizedContext };

        const promises = loggers.map(logger => {
            if (logger && typeof logger[level] === 'function') {
                return logger[level](message, data, fullContext).catch(error => {
                    console.error(`Logger ${logger.getProviderName()} ${level} failed:`, error.message);
                });
            }
            return Promise.resolve();
        });

        await Promise.all(promises);
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
        // Return the same instance to ensure mocks on the singleton work globally
        this._baseContext = { ...this._baseContext, ...this._normalizeContext(extraContext) };
        return this;
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
        const loggers = this._getLoggers();
        if (loggers && loggers.length > 0) {
            const promises = loggers.map(logger => {
                if (logger && typeof logger.flush === 'function') {
                    return logger.flush(timeoutMs).catch(err => {
                        console.error(`Logger ${logger.getProviderName()} flush failed:`, err.message);
                    });
                }
                return Promise.resolve();
            });
            await Promise.all(promises);
        }
    }

    getProviderName() {
        return this.currentProviderName;
    }

    getConnectionInfo() {
        const loggers = this._getLoggers();
        if (loggers && loggers.length > 0) {
            return {
                providers: loggers.map(l => l.getConnectionInfo())
            };
        }
        return { provider: 'unknown', connected: false };
    }

    async destroy() {
        _singletonInstance = null;
        _singletonTimestamp = Date.now();
        const loggers = this.activeLoggers;
        for (const logger of loggers) {
            if (logger && typeof logger.destroy === 'function') {
                await logger.destroy();
            }
        }
    }
}

export { LoggerService };

export const createLogger = () => new LoggerService();

export default new LoggerService();
