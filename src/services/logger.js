import { Axiom } from '@axiomhq/js';

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

const log = async (level, message, data = {}) => {
  if (!axiom) {
    await initAxiom();
  }

  if (!axiom) {
    // Axiom 未初始化时，降级到 console
    console[level](message, data);
    return;
  }

  const payload = {
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

export const resetLogger = () => {
  axiom = null;
  axiomInitialized = false;
};

export const logger = {
  info: (message, data) => log('info', message, data),
  warn: (message, data) => log('warn', message, data),
  error: (message, data) => log('error', message, data),
  debug: (message, data) => log('debug', message, data),
};