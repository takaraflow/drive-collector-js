import { AxiomLogger } from './AxiomLogger.js';
import { NewrelicLogger } from './NewrelicLogger.js';
import { ConsoleLogger } from './ConsoleLogger.js';
import {
    writeOriginalConsole
} from './console-channel.js';
import {
    defaultLogLevelForEnv,
    getConfiguredLogLevel,
    LOG_LEVEL_PRIORITY,
    LOG_LEVELS,
    normalizeLogLevel,
    shouldSendLogLevel
} from './log-level.js';

let getInstanceIdFunc = () => 'unknown';
const localFallbackId = `boot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

export {
    defaultLogLevelForEnv,
    getConfiguredLogLevel,
    LOG_LEVEL_PRIORITY,
    LOG_LEVELS,
    normalizeLogLevel,
    shouldSendLogLevel
};

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

let consoleProxyEnabled = false;
let consoleProxyPreviousMethods = null;
const CAPTURED_MESSAGE_PATTERNS = [
    'Telegram library TIMEOUT captured',
    'Telegram timeout warning captured',
    'Telegram connection event captured'
];
const CAPTURED_CONSOLE_MESSAGE_MAX_LENGTH = 500;
const TELEGRAM_CONSOLE_DEDUP_WINDOW_MS = 60_000;
const TELEGRAM_CONSOLE_DEDUP_MAX_KEYS = 100;
const telegramConsoleDedup = new Map();

const safeStringifyConsoleArg = (arg) => {
    if (arg instanceof Error) {
        return `${arg.name || 'Error'}: ${arg.message || ''}`;
    }
    if (typeof arg === 'string') return arg;
    if (arg === undefined) return 'undefined';
    if (arg === null) return 'null';

    try {
        return String(arg);
    } catch (error) {
        return '[Unstringifiable console argument]';
    }
};

const truncateCapturedConsoleMessage = (message) => {
    const text = String(message || '');
    if (text.length <= CAPTURED_CONSOLE_MESSAGE_MAX_LENGTH) return text;
    return `${text.substring(0, CAPTURED_CONSOLE_MESSAGE_MAX_LENGTH)}...`;
};

const buildCapturedConsoleMessage = (args) => {
    return truncateCapturedConsoleMessage(args.slice(0, 3).map(safeStringifyConsoleArg).join(' '));
};

const isCapturedLoggerMessage = (message) => {
    return CAPTURED_MESSAGE_PATTERNS.some(pattern => message.includes(pattern));
};

const isTimeoutPattern = (message) => {
    const msgLower = message.toLowerCase();
    return (
        msgLower.includes('timeout') ||
        msgLower.includes('etimedout') ||
        msgLower.includes('econnreset') ||
        msgLower.includes('timed out')
    );
};

const isTelegramConnectionPattern = (message) => {
    return /gramjs|tcpfull|149\.154\.|connection to .*complete|using layer|signed in successfully|disconnecting|connection closed/i.test(message);
};

const normalizeFingerprint = (kind, message) => {
    return `${kind}:${String(message)
        .toLowerCase()
        .replace(/\d{10,}/g, '#')
        .replace(/\s+/g, ' ')
        .substring(0, 200)}`;
};

const shouldCaptureConsoleEvent = (kind, message, now = Date.now()) => {
    const fingerprint = normalizeFingerprint(kind, message);
    const lastCapturedAt = telegramConsoleDedup.get(fingerprint);
    if (lastCapturedAt && now - lastCapturedAt < TELEGRAM_CONSOLE_DEDUP_WINDOW_MS) {
        return false;
    }

    telegramConsoleDedup.set(fingerprint, now);
    if (telegramConsoleDedup.size > TELEGRAM_CONSOLE_DEDUP_MAX_KEYS) {
        const oldestKey = telegramConsoleDedup.keys().next().value;
        telegramConsoleDedup.delete(oldestKey);
    }

    return true;
};

const captureTelegramConsoleEvent = (level, logMethod, message, args) => {
    if (isCapturedLoggerMessage(message)) return;
    if (!shouldCaptureConsoleEvent(logMethod, message)) return;

    const wrapper = LoggerService.getInstance();
    const data = {
        service: 'telegram',
        source: 'console_proxy',
        message,
        argumentCount: args.length,
        timestamp: Date.now()
    };
    const context = { module: 'TelegramService' };

    try {
        const logPromise = wrapper[logMethod](level, data, context);
        if (logPromise && typeof logPromise.catch === 'function') {
            logPromise.catch(error => {
                writeOriginalConsole('error', 'Telegram console capture failed:', error?.message || error);
            });
        }
    } catch (error) {
        writeOriginalConsole('error', 'Telegram console capture failed:', error?.message || error);
    }
};

export const enableTelegramConsoleProxy = () => {
    if (consoleProxyEnabled) return;

    consoleProxyPreviousMethods = {
        error: console.error,
        warn: console.warn,
        log: console.log
    };
    consoleProxyEnabled = true;

    console.error = (...args) => {
        const msg = buildCapturedConsoleMessage(args);

        if (isTimeoutPattern(msg)) {
            captureTelegramConsoleEvent('Telegram library TIMEOUT captured', 'error', msg, args);
        }

        writeOriginalConsole('error', ...args);
    };

    console.warn = (...args) => {
        const msg = buildCapturedConsoleMessage(args);

        if (isTimeoutPattern(msg)) {
            captureTelegramConsoleEvent('Telegram timeout warning captured', 'warn', msg, args);
        }

        writeOriginalConsole('warn', ...args);
    };

    console.log = (...args) => {
        const msg = buildCapturedConsoleMessage(args);

        if (isTelegramConnectionPattern(msg)) {
            captureTelegramConsoleEvent('Telegram connection event captured', 'info', msg, args);
        }

        writeOriginalConsole('log', ...args);
    };
};

export const disableTelegramConsoleProxy = () => {
    if (!consoleProxyEnabled) return;

    if (consoleProxyPreviousMethods) {
        console.error = consoleProxyPreviousMethods.error;
        console.warn = consoleProxyPreviousMethods.warn;
        console.log = consoleProxyPreviousMethods.log;
    }
    telegramConsoleDedup.clear();
    consoleProxyPreviousMethods = null;
    consoleProxyEnabled = false;
};

export const flushLogBuffer = async (timeoutMs = 10000) => {
    const instance = LoggerService.getInstance();
    await instance.flush(timeoutMs);
};

let _singletonInstance = null;
let _singletonTimestamp = Date.now();

class ScopedLogger {
    constructor(parent, boundContext = {}) {
        this._parent = parent;
        this._boundContext = parent._normalizeContext(boundContext);
    }

    _mergeContext(context = {}) {
        return {
            ...this._boundContext,
            ...this._parent._normalizeContext(context)
        };
    }

    async info(message, data = {}, context = {}) {
        await this._parent._log('info', message, data, this._mergeContext(context));
    }

    async warn(message, data = {}, context = {}) {
        await this._parent._log('warn', message, data, this._mergeContext(context));
    }

    async error(message, data = {}, context = {}) {
        await this._parent._log('error', message, data, this._mergeContext(context));
    }

    async debug(message, data = {}, context = {}) {
        await this._parent._log('debug', message, data, this._mergeContext(context));
    }

    withContext(extraContext) {
        return new ScopedLogger(this._parent, this._mergeContext(extraContext));
    }

    withModule(moduleName) {
        return this.withContext({ module: moduleName });
    }

    configure(config) {
        return this._parent.configure(config);
    }

    canSend(level) {
        return this._parent.canSend(level);
    }

    async flush(timeoutMs = 10000) {
        await this._parent.flush(timeoutMs);
    }

    getProviderName() {
        return this._parent.getProviderName();
    }

    getConnectionInfo() {
        return this._parent.getConnectionInfo();
    }

    async destroy() {
        await this._parent.destroy();
    }
}

class LoggerService {
    constructor(options = {}) {
        this.options = options;
        this.isInitialized = false;
        this.activeLoggers = [];
        this.fallbackLogger = null;
        this.currentProviderName = 'ConsoleLogger';
        this._baseContext = {};
        this._moduleLoggers = new Map();
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
        await this._initLoggers();
        this.isInitialized = true;
    }

    async _initLoggers() {
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
    }

    /**
     * 重新加载 Logger 配置（通常在配置初始化完成后调用）
     */
    async reload() {
        writeOriginalConsole('log', '[LoggerService] Reloading loggers with new configuration...');
        // 关闭旧的 loggers
        for (const logger of this.activeLoggers) {
            if (logger && typeof logger.disconnect === 'function') {
                await logger.disconnect();
            }
        }

        // 重新初始化
        await this._initLoggers();
        writeOriginalConsole('log', `[LoggerService] Reloaded. Active providers: ${this.currentProviderName}`);
    }

    _ensureInitialized() {
        if (!this.isInitialized) {
            this.initialize().catch(err => {
                writeOriginalConsole('error', 'LoggerService auto-initialization failed:', err.message);
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
        if (!this.canSend(level)) return;

        const loggers = this._getLoggers();
        if (!loggers || loggers.length === 0) return;

        // 语义化 Emoji 引擎：根据模块和内容智能选择图标
        const mod = context?.module || '';
        const moduleEmojis = {
            'HttpServer': '🌐', 'Webhook': '🌐',
            'Telegram': '✈️', 'Dispatcher': '✈️', 'TelegramService': '✈️',
            'Cache': '💾', 'Redis': '💾', 'CacheService': '💾',
            'Queue': '📬', 'Qstash': '📬', 'QueueService': '📬',
            'OSS': '☁️', 'R2': '☁️', 'OssService': '☁️',
            'D1': '🗄️', 'Database': '🗄️', 'Repository': '🗄️',
            'Config': '⚙️', 'Infisical': '⚙️',
            'InstanceCoordinator': '🏗️', 'App': '🏗️',
            'Processor': '⛓️', 'LinkParser': '⛓️', 'TaskManager': '📋',
            'Tunnel': '🚇', 'TunnelService': '🚇'
        };

        const levelEmojis = { info: 'ℹ️', warn: '⚠️', error: '🚨', debug: '🔍' };
        let emoji = moduleEmojis[mod] || levelEmojis[level] || '';

        // 智能语义追加：根据消息内容增强图标
        const msgStr = String(message).substring(0, 2000);

        if (msgStr.includes('启动') || msgStr.includes('Start')) emoji += '🚀';
        if (msgStr.includes('完成') || msgStr.includes('成功') || msgStr.includes('success') || msgStr.includes('✅')) {
            if (!emoji.includes('✅')) emoji += '✅';
        }
        if (msgStr.includes('失败') || msgStr.includes('failed') || msgStr.includes('❌')) {
            if (!emoji.includes('❌')) emoji += '❌';
        }
        if (msgStr.includes('连接') || msgStr.includes('Connect') || msgStr.includes('🔗')) {
            if (!emoji.includes('🔗')) emoji += '🔗';
        }
        if (msgStr.includes('停止') || msgStr.includes('Stop') || msgStr.includes('🛑')) {
            if (!emoji.includes('🛑')) emoji += '🛑';
        }

        const formattedMessage = `${emoji} ${message}`;

        const normalizedContext = this._normalizeContext(context);
        const fullContext = { ...this._getContext(), ...normalizedContext };

        const promises = loggers.map(logger => {
            if (logger && typeof logger[level] === 'function') {
                return logger[level](formattedMessage, data, fullContext).catch(error => {
                    writeOriginalConsole('error', `Logger ${logger.getProviderName()} ${level} failed:`, error.message);
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
        return new ScopedLogger(this, extraContext);
    }

    withModule(moduleName) {
        const normalizedContext = this._normalizeContext({ module: moduleName });
        const cacheKey = normalizedContext.module || '';
        if (!this._moduleLoggers.has(cacheKey)) {
            this._moduleLoggers.set(cacheKey, new ScopedLogger(this, normalizedContext));
        }
        return this._moduleLoggers.get(cacheKey);
    }

    configure(config) {
    }

    isInitialized() {
        return this.isInitialized;
    }

    canSend(level) {
        return shouldSendLogLevel(level);
    }

    async flush(timeoutMs = 10000) {
        const loggers = this._getLoggers();
        if (loggers && loggers.length > 0) {
            const promises = loggers.map(logger => {
                if (logger && typeof logger.flush === 'function') {
                    return logger.flush(timeoutMs).catch(err => {
                        writeOriginalConsole('error', `Logger ${logger.getProviderName()} flush failed:`, err.message);
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

export default LoggerService.getInstance();
