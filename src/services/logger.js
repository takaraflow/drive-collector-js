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

    // 如果没有环境变量，跳过初始化，直接使用console
    axiomInitialized = true;
    return;

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

/**
 * 限制对象字段数量，防止超过 Axiom 的列数限制
 * @param {Object} obj - 要限制的对象
 * @param {number} maxFields - 最大字段数，默认 200（留出安全余量）
 * @returns {Object} - 限制后的对象
 */
const limitFields = (obj, maxFields = 200) => {
  if (!obj || typeof obj !== 'object') return obj;
  
  const result = {};
  let count = 0;
  
  for (const key in obj) {
    if (count >= maxFields) {
      // 添加一个标记表示字段被截断
      result._truncated = true;
      break;
    }
    
    if (obj.hasOwnProperty(key)) {
      result[key] = obj[key];
      count++;
    }
  }
  
  return result;
};

/**
 * 安全地检查和获取数据集名称
 * @returns {string} - 数据集名称
 */
const getSafeDatasetName = () => {
  // 优先使用环境变量
  if (process.env.AXIOM_DATASET) {
    return process.env.AXIOM_DATASET;
  }
  
  // 其次使用 config 中的值
  if (config && config.axiom && config.axiom.dataset) {
    return config.axiom.dataset;
  }
  
  // 最后使用默认值
  return 'drive-collector';
};

/**
 * 安全的 Axiom ingest 调用，包含错误处理和响应验证
 * @param {string} dataset - 数据集名称
 * @param {Array} payload - 要发送的数据
 * @returns {Promise<boolean>} - 是否成功
 */
const safeAxiomIngest = async (dataset, payload) => {
  if (!axiom || !dataset) {
    return false;
  }

  try {
    const result = await axiom.ingest(dataset, payload);
    
    // 验证响应：Axiom ingest 通常返回 undefined 或成功响应
    // 如果返回了响应对象，检查是否有错误字段
    if (result && typeof result === 'object') {
      if (result.error || result.status === 'error') {
        throw new Error(result.error || 'Axiom ingest returned error status');
      }
    }
    
    return true;
  } catch (error) {
    // 检查是否是 JSON 解析错误
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      // JSON 解析错误，可能是空响应或非 JSON 响应
      // 这种情况下我们认为是网络问题，应该重试
      throw new Error(`Axiom JSON parsing failed: ${error.message}`);
    }
    
    // 检查是否是字段超限错误
    if (error.message && error.message.includes('column limit')) {
      throw new Error(`Axiom column limit exceeded: ${error.message}`);
    }
    
    // 其他错误直接抛出
    throw error;
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

/**
 * 递归裁剪对象，限制深度和字段数量
 * @param {any} obj - 要裁剪的对象
 * @param {number} maxDepth - 最大深度
 * @param {number} maxKeys - 每个对象的最大键数
 * @param {number} currentDepth - 当前深度
 * @returns {any} - 裁剪后的对象
 */
const pruneData = (obj, maxDepth = 3, maxKeys = 20, currentDepth = 0) => {
  if (currentDepth >= maxDepth) {
      if (typeof obj === 'object' && obj !== null) {
          return '[Truncated: Max Depth]';
      }
      return obj;
  }
  
  if (obj === null || typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
      const prunedArray = obj.slice(0, maxKeys).map(item => pruneData(item, maxDepth, maxKeys, currentDepth + 1));
      if (obj.length > maxKeys) {
          prunedArray.push('[Truncated: Max Array Length]');
      }
      return prunedArray;
  }

  // Error 对象特殊处理
  if (obj instanceof Error) {
      const serialized = serializeError(obj);
      return pruneData(serialized, maxDepth, maxKeys, currentDepth);
  }

  const newObj = {};
  let keyCount = 0;
  
  for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (keyCount >= maxKeys) {
              newObj['_truncated_keys'] = `... ${Object.keys(obj).length - maxKeys} more keys`;
              break;
          }
          newObj[key] = pruneData(obj[key], maxDepth, maxKeys, currentDepth + 1);
          keyCount++;
      }
  }
  return newObj;
};

const log = async (instanceId, level, message, data = {}) => {
  // 确保 data 是一个对象且不是 Error 实例
  let finalData = data;
  if (data && typeof data !== 'object') {
      finalData = { value: data };
  } else if (data instanceof Error) {
      finalData = serializeError(data);
  }

  // 确保版本已初始化
  await initVersion();

  if (!axiom) {
    await initAxiom();
  }

  const displayMessage = `[v${version}] ${message}`;

  if (!axiom) {
    // Axiom 未初始化时，降级到原生 console，防止触发 Proxy 递归
    const fallback = { error: originalConsoleError, warn: originalConsoleWarn, log: originalConsoleLog }[level] || originalConsoleLog;
    fallback.call(console, displayMessage, finalData);
    return;
  }

  // 序列化数据并进行深度剪裁，防止字段爆炸
  const prunedData = pruneData(finalData, 3, 20);
  
  // 构建基础 Payload，严格控制顶层字段
  const payload = {
    version,
    instanceId,
    level,
    message: displayMessage,
    timestamp: new Date().toISOString(),
    // 在Cloudflare Worker环境下获取一些额外信息
    worker: {
      id: global.WORKER_ID, // 假设全局有WORKER_ID
      env: config ? config.env : undefined,
    }
  };

  // 提取常用索引字段 (White-list)，避免污染顶层 Schema
  const INDEXED_KEYS = ['userId', 'chatId', 'taskId', 'service', 'action', 'source', 'duration'];
  INDEXED_KEYS.forEach(key => {
    if (finalData && finalData[key] !== undefined && finalData[key] !== null) {
      payload[key] = finalData[key];
    }
  });

  // 特殊处理 Error 对象，提取关键信息到独立字段
  const errObj = finalData instanceof Error ? finalData : (finalData.error instanceof Error ? finalData.error : null);
  if (errObj) {
      payload.error_name = errObj.name;
      payload.error_message = errObj.message;
      // stack 放入 details
  } else if (finalData.error) {
      // 处理非 Error 实例的 error 字段
      payload.error_summary = String(finalData.error).substring(0, 200);
  }

  // 将所有数据（包括被提取的字段）序列化存入 details 字段
  // 这样做彻底解决了字段爆炸问题，因为 Axiom 不会解析字符串内部的结构作为列
  try {
      payload.details = JSON.stringify(prunedData);
  } catch (e) {
      payload.details = '[JSON Stringify Error]';
  }

  // 最后的安全网：限制顶层字段 (虽然现在不太可能超限了)
  const finalPayload = limitFields(payload, 50);

  try {
    const dataset = getSafeDatasetName();
    await safeAxiomIngest(dataset, [finalPayload]);
  } catch (err) {
    // Retry logic with exponential backoff (max 3 attempts)
    // 使用 retryWithDelay 以便测试中可以 mock
    await retryWithDelay(async () => {
      const dataset = getSafeDatasetName(); // 每次重试都重新获取数据集名称
      if (!dataset || !axiom) {
        throw new Error('Axiom not properly configured for retry');
      }
      await safeAxiomIngest(dataset, [finalPayload]);
    }, 3, (attempt) => Math.pow(2, attempt) * 1000).catch((lastError) => {
      // Fallback: log to console only (avoid recursive calls)
      // Use original console.error to avoid proxy recursion
      originalConsoleError.call(console, 'Axiom ingest failed after retries:', lastError.message);
      // 为了避免控制台也被撑爆，对 fallback 的 payload 也做一下 prune
      originalConsoleError.call(console, 'Failed payload:', {
        service: data.service || 'unknown',
        error: serializeError(lastError),
        payload: pruneData(finalPayload, 2, 10)
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
