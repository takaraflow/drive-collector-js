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

    // 在测试环境中立即设置版本，避免异步操作
    if (process.env.NODE_ENV === 'test') {
        version = 'test';
        return;
    }

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
        // 移除 console.debug，静默失败
    }
};

/**
 * 可 mock 的延迟函数，用于测试
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
export const delay = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * 带重试的异步操作包装器
 * @param {Function} fn - 要重试的异步函数
 * @param {number} maxRetries - 最大重试次数
 * @param {Function} delayFn - 延迟计算函数 (attempt) => ms
 * @returns {Promise<any>} - 成功的结果或抛出最后一个错误
 */
export const retryWithDelay = async (fn, maxRetries = 3, delayFn = (attempt) => Math.pow(2, attempt) * 1000) => {
  let lastError;
  for (let retries = 0; retries < maxRetries; retries++) {
    try {
      return await fn();
    } catch (retryErr) {
      lastError = retryErr;
      if (retries < maxRetries - 1) {
        const delayMs = delayFn(retries);
        await delay(delayMs);
      }
    }
  }
  throw lastError;
};

const initAxiom = async () => {
  if (axiomInitialized) return;

  try {
    // 优先使用环境变量（支持测试环境）
    const envToken = process.env.AXIOM_TOKEN;
    const envOrgId = process.env.AXIOM_ORG_ID;
    const envDataset = process.env.AXIOM_DATASET;

    if (envToken && envOrgId) {
      axiom = new Axiom({
        token: envToken,
        orgId: envOrgId,
      });
      config = config || {};
      config.axiom = {
        token: envToken,
        orgId: envOrgId,
        dataset: envDataset || 'drive-collector'
      };
      axiomInitialized = true;
      return;
    }

    // 回退到 config 模块
    if (!config) {
      try {
        const configModule = await import('../config/index.js');
        config = configModule.config;
      } catch (e) {
        // 在 Worker 环境下，如果无法加载 config/index.js，则依赖手动配置
        // 移除 console.debug
      }
    }

    if (config && config.axiom && config.axiom.token && config.axiom.orgId) {
      axiom = new Axiom({
        token: config.axiom.token,
        orgId: config.axiom.orgId,
      });
    }
  } catch (error) {
    // 移除 console.error
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
  // 在测试环境下，如果 getInstanceIdFunc 返回 unknown，减少 debug 日志输出频率
  // 避免干扰测试结果

  // 确保版本已初始化
  await initVersion();

  if (!axiom) {
    await initAxiom();
  }

  const displayMessage = `[v${version}] ${message}`;

  if (!axiom) {
    // Axiom 未初始化时，降级到原生 console，防止触发 Proxy 递归
    const fallback = { error: originalConsoleError, warn: originalConsoleWarn, log: originalConsoleLog }[level] || originalConsoleLog;
    fallback.call(console, displayMessage, data);
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
    // Retry logic with exponential backoff (max 3 attempts)
    // 使用 retryWithDelay 以便测试中可以 mock
    await retryWithDelay(async () => {
      await axiom.ingest(config.axiom.dataset, [payload]);
    }, 3, (attempt) => Math.pow(2, attempt) * 1000).catch((lastError) => {
      // Fallback: log to console only (avoid recursive calls)
      // Use original console.error to avoid proxy recursion
      originalConsoleError.call(console, 'Axiom ingest failed after retries:', lastError.message);
      originalConsoleError.call(console, 'Failed payload:', {
        service: data.service || 'unknown',
        error: serializeError(lastError),
        payload: payload
      });
    });
  }
};

const getSafeInstanceId = () => {
    try {
        const id = getInstanceIdFunc();
        if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
            return id;
        }
        // 如果返回了 'unknown' 或无效值，使用本地 fallback
        // 在测试环境下减少此类日志输出，除非显式开启 DEBUG
        if (process.env.NODE_ENV !== 'test' || process.env.DEBUG === 'true') {
            // 移除 console.debug
        }
        return localFallbackId;
    } catch (e) {
        if (process.env.NODE_ENV !== 'test' || process.env.DEBUG === 'true') {
            // 移除 console.debug
        }
        return localFallbackId;
    }
};

// Use a simple object with methods for the logger to avoid Proxy issues in tests/production
export const logger = {
    info: (message, data) => log(getSafeInstanceId(), 'info', message, data),
    warn: (message, data) => log(getSafeInstanceId(), 'warn', message, data),
    error: (message, data) => log(getSafeInstanceId(), 'error', message, data),
    debug: (message, data) => {
        // Debug logs should not be output to console when Axiom is not configured
        if (!process.env.AXIOM_TOKEN && (!config || !config.axiom)) return;
        return log(getSafeInstanceId(), 'debug', message, data);
    },
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
    const msgLower = msg.toLowerCase();
    
    // Enhanced timeout detection - covers all variants from the plan
    const isTimeoutPattern =
      msgLower.includes('timeout') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNRESET') ||
      msg.includes('timed out') ||
      msg.includes('TIMEOUT');
    
    if (isTimeoutPattern) {
      logger.error(`Telegram library TIMEOUT captured: ${msg}`, {
        service: 'telegram',
        source: 'console_proxy',
        args: args.length > 1 ? args.slice(1) : undefined,
        timestamp: Date.now()
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
