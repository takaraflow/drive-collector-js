import { BaseLogger } from './BaseLogger.js';
import { resolveBuildVersion } from './version.js';

class ConsoleLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;
        this.originalConsoleLog = console.log;
        this.version = resolveBuildVersion();
    }

    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;
    }

    _formatMessage(level, message, data, context, instanceId) {
        const modulePrefix = context?.module ? `[${context.module}] ` : '';
        const envStr = this._getEnv();
        return `[v${this.version}] [${envStr}] [${instanceId}] ${modulePrefix}${message}`;
    }

    _getEnv() {
        // CF Worker 兼容性处理
        if (typeof globalThis !== 'undefined' && globalThis.NODE_ENV) {
            return globalThis.NODE_ENV;
        }
        if (typeof process !== 'undefined' && process.env?.NODE_ENV) {
            return process.env.NODE_ENV;
        }
        return 'unknown';
    }

    _getConsoleMethod(level) {
        const methods = {
            error: this.originalConsoleError,
            warn: this.originalConsoleWarn,
            log: this.originalConsoleLog
        };
        return methods[level] || this.originalConsoleLog;
    }

    _serializeToString(data) {
        if (data === undefined) return '{"value":"undefined"}';
        if (typeof data === 'function') return '{"value":"[Function]"}';
        if (typeof data === 'symbol') return `{"value":"${String(data)}"}`;
        
        try {
            return JSON.stringify(data, (key, value) => {
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

    async _log(level, message, data = {}, context = {}) {
        const instanceId = 'console';
        const formattedMessage = this._formatMessage(level, message, data, context, instanceId);
        const consoleMethod = this._getConsoleMethod(level);

        const details = this._serializeToString(data);
        consoleMethod(formattedMessage, { context, details });
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

    async flush() {
        // Console logger doesn't need to flush
    }
}

export { ConsoleLogger };
