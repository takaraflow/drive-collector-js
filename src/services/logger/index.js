export { BaseLogger } from './BaseLogger.js';
export { AxiomLogger } from './AxiomLogger.js';
export { ConsoleLogger } from './ConsoleLogger.js';
export { DatadogLogger } from './DatadogLogger.js';
export { NewrelicLogger } from './NewrelicLogger.js';

import {
    LoggerService,
    createLogger,
    setInstanceIdProvider as setLoggerServiceInstanceIdProvider,
    enableTelegramConsoleProxy,
    disableTelegramConsoleProxy,
    flushLogBuffer,
    defaultLogLevelForEnv,
    getConfiguredLogLevel,
    normalizeLogLevel,
    shouldSendLogLevel
} from './LoggerService.js';
import { setInstanceIdProvider as setAxiomInstanceIdProvider } from './AxiomLogger.js';
import { setInstanceIdProvider as setNewrelicInstanceIdProvider } from './NewrelicLogger.js';

export {
    LoggerService,
    enableTelegramConsoleProxy,
    disableTelegramConsoleProxy,
    flushLogBuffer,
    createLogger,
    defaultLogLevelForEnv,
    getConfiguredLogLevel,
    normalizeLogLevel,
    shouldSendLogLevel
};

export const setInstanceIdProvider = (provider) => {
    setLoggerServiceInstanceIdProvider(provider);
    setAxiomInstanceIdProvider(provider);
    setNewrelicInstanceIdProvider(provider);
};

export const setLoggerInstanceIdProvider = setInstanceIdProvider;

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
