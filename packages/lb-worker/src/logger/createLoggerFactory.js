import { normalizeEnvName } from '../utils/env.js';
import { baseLoggerConfig } from './baseConfig.js';
import { isTestEnvironment } from './runtimeEnv.js';
import { VERSION } from './version.js';
import { formatMessage } from './formatMessage.js';
import { sanitizeLogData } from './sanitizeLogData.js';
import { addOtelEvent } from './otel.js';

const isDevEnv = (env) => normalizeEnvName(env) === 'dev';

let globalLoggerInstance = null;

export function getGlobalLoggerBuffer() {
  if (globalLoggerInstance && globalLoggerInstance._privateBuffer) {
    return globalLoggerInstance._privateBuffer;
  }
  return [];
}

function pushToBuffer(logData, logBuffer) {
  const sanitizedData = sanitizeLogData(logData);
  if (logBuffer && Array.isArray(logBuffer)) {
    logBuffer.push(sanitizedData);
    if (logBuffer.length > 1000) {
      logBuffer.splice(0, logBuffer.length - 1000);
    }
    return;
  }
  if (logBuffer && typeof logBuffer.push === 'function') {
    logBuffer.push(sanitizedData);
  }
}

/**
 * @typedef {Object} LoggerContext
 * @property {string} env
 * @property {Array<Object>} [logBuffer]
 */

/**
 * Legacy-compatible logger factory used across the codebase.
 * @param {LoggerContext} context
 * @param {Record<string, any>} bindings
 */
export function createLoggerFactory(context, bindings = {}) {
  const logBuffer = context.logBuffer || [];

  if (!context.logBuffer) {
    globalLoggerInstance = null;
  }

  const _log = async (level, message, data = {}, span = null, ctx = null, categoryOverride = null) => {
    const category = categoryOverride || data.category || data.module || bindings.module;
    const formattedMsg = formatMessage(message, level, category);

    const logData = {
      level,
      message: formattedMsg,
      env: normalizeEnvName(context.env || 'prod'),
      ...bindings,
      ...data,
      version: VERSION,
      timestamp: new Date().toISOString()
    };

    if (context.env) {
      logData.env = normalizeEnvName(context.env);
    }

    addOtelEvent(level, formattedMsg, logData, span);

    const shouldBuffer =
      level !== 'debug' || isDevEnv(context.env) || isTestEnvironment || baseLoggerConfig.debugEnabled;

    if (shouldBuffer) {
      pushToBuffer(logData, context.logBuffer || logBuffer);
    }

    if (isDevEnv(context.env)) {
      const consoleMethod = console[level] || console.log;
      consoleMethod(`[${level.toUpperCase()}] ${formattedMsg}`, { ...bindings, ...data, version: VERSION });
    }
  };

  const logger = {
    version: VERSION,
    env: normalizeEnvName(context.env || 'prod'),
    bindings,

    info: (message, data = {}, span = null, ctx = null) => _log('info', message, data, span, ctx),
    warn: (message, data = {}, span = null, ctx = null) => _log('warn', message, data, span, ctx),
    error: (message, data = {}, span = null, ctx = null) => _log('error', message, data, span, ctx),
    debug: (message, data = {}, span = null, ctx = null) => _log('debug', message, data, span, ctx),
    success: (message, data = {}, span = null, ctx = null) => _log('info', message, data, span, ctx, 'success'),

    child: function child(childBindings = {}) {
      const { logBuffer: childLogBuffer, env: childEnv, ...incomingBindings } = childBindings;
      const mergedBindings = { ...logger.bindings, ...incomingBindings };
      const newContext = { ...context };

      if (childLogBuffer !== undefined) {
        if (Array.isArray(childLogBuffer)) {
          newContext.logBuffer = childLogBuffer;
        } else if (childLogBuffer && typeof childLogBuffer.getAll === 'function') {
          newContext.logBuffer = childLogBuffer.getAll();
        } else {
          newContext.logBuffer = [];
        }
      }

      if (childEnv !== undefined) {
        newContext.env = normalizeEnvName(childEnv);
      }

      return createLoggerFactory(newContext, mergedBindings);
    },

    configure: function configure(config = {}) {
      if (config.env) {
        const normalized = normalizeEnvName(config.env);
        context.env = normalized;
        logger.env = normalized;
      }
    }
  };

  logger._privateBuffer = logBuffer;
  if (!context.logBuffer) {
    globalLoggerInstance = logger;
  }

  return logger;
}
