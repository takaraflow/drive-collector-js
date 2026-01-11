export { BaseLogger } from './BaseLogger.js';
export { AxiomLogger } from './AxiomLogger.js';
export { ConsoleLogger } from './ConsoleLogger.js';
export { DatadogLogger } from './DatadogLogger.js';

import { LoggerService, createLogger, setInstanceIdProvider, enableTelegramConsoleProxy, disableTelegramConsoleProxy, flushLogBuffer } from './LoggerService.js';

export { LoggerService, setInstanceIdProvider, enableTelegramConsoleProxy, disableTelegramConsoleProxy, flushLogBuffer, createLogger };

let _loggerInstance;
try {
    _loggerInstance = new LoggerService();
} catch (e) {
    _loggerInstance = {
        info: (...args) => console.info('[LOG]', ...args),
        warn: (...args) => console.warn('[LOG]', ...args),
        error: (...args) => console.error('[LOG]', ...args),
        debug: (...args) => console.debug('[LOG]', ...args),
        withModule: () => _loggerInstance,
        withContext: () => _loggerInstance,
        configure: () => {},
        isInitialized: () => false,
        canSend: () => false,
        flush: async () => {},
        getProviderName: () => 'ConsoleLogger',
        getConnectionInfo: () => ({ provider: 'ConsoleLogger', connected: false })
    };
}
export { _loggerInstance as logger };
export default _loggerInstance;