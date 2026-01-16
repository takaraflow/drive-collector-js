import { normalizeEnvName } from '../utils/env.js';

export const baseLoggerConfig = {
  dataset: null,
  token: null,
  orgId: null,
  env: 'prod',
  debugEnabled: false
};

/**
 * Configure base logger transport settings from CF Worker env bindings.
 * @param {Record<string, any>} env
 */
export function configureBaseLoggerTransport(env = {}) {
  const debugFlag = String(env.DEBUG_LOGS || '').toLowerCase();
  baseLoggerConfig.debugEnabled = ['true', '1', 'yes', 'on'].includes(debugFlag);

  if (env.AXIOM_TOKEN && env.AXIOM_DATASET) {
    baseLoggerConfig.dataset = env.AXIOM_DATASET;
    baseLoggerConfig.token = env.AXIOM_TOKEN;
    baseLoggerConfig.orgId = env.AXIOM_ORG_ID || null;
    baseLoggerConfig.env = normalizeEnvName(env.NODE_ENV || 'prod');
  }

  if (typeof globalThis !== 'undefined') {
    if (baseLoggerConfig.token) globalThis.AXIOM_TOKEN = baseLoggerConfig.token;
    if (baseLoggerConfig.dataset) globalThis.AXIOM_DATASET = baseLoggerConfig.dataset;
    if (baseLoggerConfig.orgId) globalThis.AXIOM_ORG_ID = baseLoggerConfig.orgId;
  }
}

