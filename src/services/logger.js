import { Axiom } from '@axiomhq/js';
// Removed InstanceCoordinator dependency to avoid circular import
let getInstanceIdFunc = () => 'unknown';

export const setInstanceIdProvider = (provider) => {
    getInstanceIdFunc = provider;
};

let axiom = null;
let axiomInitialized = false;

let config = null;

const initAxiom = async () => {
  if (axiomInitialized) return;

  try {
    // 动态导入 config 以避免循环依赖
    const configModule = await import('../config/index.js');
    config = configModule.config;

    if (config.axiom && config.axiom.token && config.axiom.orgId) {
      axiom = new Axiom({
        token: config.axiom.token,
        orgId: config.axiom.orgId,
      });
    }
  } catch (error) {
    console.error('Failed to initialize Axiom:', error.message);
  } finally {
    axiomInitialized = true;
  }
};

const log = async (instanceId, level, message, data = {}) => {
  if (!axiom) {
    await initAxiom();
  }

  if (!axiom) {
    // Axiom 未初始化时，降级到 console
    console[level](message, data);
    return;
  }

  const payload = {
    instanceId,
    level,
    message,
    ...data,
    timestamp: new Date().toISOString(),
    // 在Cloudflare Worker环境下获取一些额外信息
    worker: {
      id: global.WORKER_ID, // 假设全局有WORKER_ID
      env: config ? config.env : undefined,
    }
  };

  try {
    await axiom.ingest(config.axiom.dataset, [payload]);
  } catch (err) {
    console.error('Axiom ingest error:', err.message);
  }
};

const getSafeInstanceId = () => {
    try {
        return getInstanceIdFunc();
    } catch {
        return 'unknown';
    }
};

// Use a simple object with methods for the logger to avoid Proxy issues in tests/production
export const logger = {
    info: (message, data) => log(getSafeInstanceId(), 'info', message, data),
    warn: (message, data) => log(getSafeInstanceId(), 'warn', message, data),
    error: (message, data) => log(getSafeInstanceId(), 'error', message, data),
    debug: (message, data) => log(getSafeInstanceId(), 'debug', message, data)
};

export const resetLogger = () => {
  axiom = null;
  axiomInitialized = false;
};

export default logger;
