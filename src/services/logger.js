import { Axiom } from '@axiomhq/js';
// Removed InstanceCoordinator dependency to avoid circular import
let getInstanceIdFunc = () => 'unknown';

// Local fallback ID based on startup timestamp and random string
const localFallbackId = `boot_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

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
        const { default: pkg } = await import('../../package.json', { with: { type: 'json' } });
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
        const id = getInstanceIdFunc();
        if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
            return id;
        }
        // 如果返回了 'unknown' 或无效值，使用本地 fallback
        console.debug('Logger: Instance ID provider returned invalid value, using fallback', { received: id, fallback: localFallbackId });
        return localFallbackId;
    } catch (e) {
        console.debug('Logger: Instance ID provider failed, using fallback', { error: e.message, fallback: localFallbackId });
        return localFallbackId;
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
    isInitialized: () => axiomInitialized,
    canSend: (level) => true
};

/**
 * Enable console proxy for Telegram library errors
 * Captures console.error calls from GramJS and routes them to structured logging
 */
let consoleProxyEnabled = false;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

export const enableTelegramConsoleProxy = () => {
  if (consoleProxyEnabled) return;
  
  consoleProxyEnabled = true;
  
  // Proxy console.error to capture Telegram library errors
  console.error = (...args) => {
    const msg = args[0]?.toString() || '';
    
    // Detect Telegram timeout errors from _updateLoop
    if (msg.includes('TIMEOUT') && msg.includes('updates.js')) {
      logger.error('Telegram _updateLoop TIMEOUT captured', {
        message: msg,
        fullArgs: args.length > 1 ? args.slice(1) : undefined,
        source: 'console_proxy'
      });
    }
    // Detect other timeout patterns
    else if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
      logger.warn('Telegram network error captured', {
        message: msg,
        fullArgs: args.length > 1 ? args.slice(1) : undefined,
        source: 'console_proxy'
      });
    }
    
    // Call original
    originalConsoleError.call(console, ...args);
  };
  
  // Proxy console.warn for completeness
  console.warn = (...args) => {
    const msg = args[0]?.toString() || '';
    
    if (msg.includes('TIMEOUT') || msg.includes('timeout')) {
      logger.warn('Telegram timeout warning captured', {
        message: msg,
        source: 'console_proxy'
      });
    }
    
    originalConsoleWarn.call(console, ...args);
  };
  
  console.log = (...args) => {
    const msg = args[0]?.toString() || '';
    
    // Capture connection state logs
    if (msg.includes('connected') || msg.includes('disconnected') || msg.includes('connection')) {
      logger.info('Telegram connection event captured', {
        message: msg,
        source: 'console_proxy'
      });
    }
    
    originalConsoleLog.call(console, ...args);
  };
};

export const disableTelegramConsoleProxy = () => {
  if (!consoleProxyEnabled) return;
  
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  console.log = originalConsoleLog;
  consoleProxyEnabled = false;
};

export const resetLogger = () => {
  axiom = null;
  axiomInitialized = false;
  version = 'unknown';
  // Reset console proxy if enabled
  if (consoleProxyEnabled) {
    disableTelegramConsoleProxy();
  }
};

// 确保同时支持 named export 和 default export
export default logger;