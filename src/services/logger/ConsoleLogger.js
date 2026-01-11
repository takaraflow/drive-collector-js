import { BaseLogger } from './BaseLogger.js';
import { serializeToString } from '../../utils/serializer.js';

class ConsoleLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;
        this.originalConsoleLog = console.log;
        this.version = 'unknown';
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
        } catch (e) {}
    }

    _formatMessage(level, message, data, context, instanceId) {
        const modulePrefix = context?.module ? `[${context.module}] ` : '';
        const envStr = process.env.NODE_ENV || 'unknown';
        return `[v${this.version}] [${envStr}] [${instanceId}] ${modulePrefix}${message}`;
    }

    _getConsoleMethod(level) {
        const methods = {
            error: this.originalConsoleError,
            warn: this.originalConsoleWarn,
            log: this.originalConsoleLog
        };
        return methods[level] || this.originalConsoleLog;
    }

    async _log(level, message, data = {}, context = {}) {
        await this._initVersion();

        const instanceId = 'console';
        const formattedMessage = this._formatMessage(level, message, data, context, instanceId);
        const consoleMethod = this._getConsoleMethod(level);

        const details = serializeToString(data);
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
    }
}

export { ConsoleLogger };
