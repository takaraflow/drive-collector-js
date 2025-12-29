import { Axiom } from '@axiomhq/js';
// Removed InstanceCoordinator dependency to avoid circular import
let getInstanceIdFunc = () => 'unknown';

export const setInstanceIdProvider = (provider) => {
    getInstanceIdFunc = provider;
};

let axiom = null;
let axiomInitialized = false;

let config = null;

// Version caching
let version = 'unknown';

const initVersion = async () => {
    if (version !== 'unknown') return;
    
    try {
        // 方案 A: 尝试通过环境变量读取（CI/CD 注入）
        if (process.env.APP_VERSION) {
            version = process.env.APP_VERSION;
            return;
        }
        
        // 方案 B: 动态读取 package.json
        const { default: pkg } = await import('../../package.json', { assert: { type: 'json' } });
        version = pkg.version || 'unknown';
    } catch (e) {
        console.debug('Logger: Failed to load version from package.json', e.message);
    }
};

const initAxiom = async () => {
  if (axiomInitialized) return;

  try {
    if (!config) {
      try {
        const configModule = await import('../config/index.js');
        config = configModule.config;
      } catch (e) {
        // 在 Worker 环境下，如果无法加载 config/index.js，则依赖手动配置
        console.debug('Logger: Falling back to manual configuration');
      }
    }

    if (config && config.axiom && config.axiom.token && config.axiom.orgId) {
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

const serializeError = (err) => {
  if (!(err instanceof Error)) return err;
  const serialized = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  // Add any additional enumerable properties
  for (const key in err) {
    if (err.hasOwnProperty(key) && !(key in serialized)) {
      serialized[key] = err[key];
    }
  }
  return serialized;
};

const serializeData = (data) => {
  if (!data) return {};
  if (data instanceof Error) return serializeError(data);
  if (typeof data === 'object') {
    const serialized = {};
    for (const key in data) {
      if (data.hasOwnProperty(key)) {
        serialized[key] = data[key] instanceof Error ? serializeError(data[key]) : data[key];
      }
    }
    return serialized;
  }
  return data;
};

const log = async (instanceId, level, message, data = {}) => {
  // 确保版本已初始化
  await initVersion();

  if (!axiom) {
    await initAxiom();
  }

  const displayMessage = `[v${version}] ${message}`;

  if (!axiom) {
    // Axiom 未初始化时，降级到 console
    console[level](displayMessage, data);
    return;
  }

  const payload = {
    version,
    instanceId,
    level,
    message: displayMessage,
    ...serializeData(data),
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
    debug: (message, data) => log(getSafeInstanceId(), 'debug', message, data),
    configure: (customConfig) => {
        config = { ...config, ...customConfig };
        // 如果提供了 axiom 配置，重置初始化状态以便重新初始化
        if (customConfig.axiom) {
            axiom = null;
            axiomInitialized = false;
        }
    },
    isInitialized: () => axiomInitialized
};

export const resetLogger = () => {
  axiom = null;
  axiomInitialized = false;
  version = 'unknown';
};

export default logger;