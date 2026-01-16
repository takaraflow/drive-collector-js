export { BaseLogger } from './BaseLogger.js';
export { AxiomLogger } from './AxiomLogger.js';
export { ConsoleLogger } from './ConsoleLogger.js';

export { LoggerService, createLogger } from './LoggerService.js';

export {
  logger,
  configureBaseLoggerTransport,
  isTestEnvironment,
  sanitizeLogData,
  flushLogs,
  flushGlobalLoggerBuffer,
  getGlobalLoggerBuffer,
  VERSION,
  updateVersionFromEnv
} from './compat.js';

export default logger;
