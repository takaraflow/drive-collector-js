/**
 * Runtime environment helpers (CF Workers compatible)
 */

const getNodeEnv = () => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.NODE_ENV;
  }
  if (typeof globalThis !== 'undefined' && globalThis.NODE_ENV) {
    return globalThis.NODE_ENV;
  }
  return undefined;
};

export const isTestEnvironment = (() => {
  const nodeEnv = String(getNodeEnv() || '').toLowerCase();
  if (nodeEnv === 'test' || nodeEnv === 'testing') return true;

  if (typeof globalThis !== 'undefined') {
    if (globalThis.__TEST__ || globalThis.__TEST_ENV__ || globalThis.__TEST_ENVIRONMENT__) return true;
    if (globalThis.VITEST === 'true') return true;
  }

  return false;
})();

