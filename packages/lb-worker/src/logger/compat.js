/**
 * Backward compatible logger exports (replacement for legacy `src/logger.js`)
 * Keeps the public surface used across the codebase while decoupling transports.
 */

import { configureBaseLoggerTransport, baseLoggerConfig } from './baseConfig.js';
import { createLoggerFactory, getGlobalLoggerBuffer as getGlobalLoggerBufferImpl } from './createLoggerFactory.js';
import { isTestEnvironment } from './runtimeEnv.js';
import { sanitizeLogData } from './sanitizeLogData.js';
import { updateVersionFromEnv, VERSION } from './version.js';
import { LoggerService } from './LoggerService.js';

export { configureBaseLoggerTransport, isTestEnvironment, sanitizeLogData, updateVersionFromEnv, VERSION };

export const logger = createLoggerFactory({ env: baseLoggerConfig.env, logBuffer: undefined });

export function getGlobalLoggerBuffer() {
  return getGlobalLoggerBufferImpl();
}

export async function flushLogs(logBuffer, timeoutMs = 10000) {
  const env = {};
  if (baseLoggerConfig.token) env.AXIOM_TOKEN = baseLoggerConfig.token;
  if (baseLoggerConfig.dataset) env.AXIOM_DATASET = baseLoggerConfig.dataset;
  if (baseLoggerConfig.orgId) env.AXIOM_ORG_ID = baseLoggerConfig.orgId;

  const service = LoggerService.getInstance();
  await service.flushLogBuffer(logBuffer, timeoutMs, env);
}

export async function flushGlobalLoggerBuffer(timeoutMs = 10000) {
  const buf = getGlobalLoggerBuffer();
  if (!buf || buf.length === 0) return;
  await flushLogs(buf, timeoutMs);
}

export default logger;
