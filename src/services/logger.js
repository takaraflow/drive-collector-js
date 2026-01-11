import { Axiom } from '@axiomhq/js';
import { 
  limitFields, 
  serializeError, 
  pruneData, 
  serializeToString 
} from '../utils/serializer.js';

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

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

// Version caching - use process.env.npm_package_version in test for faster initialization
let version = 'unknown';

const BATCH_MAX_SIZE = 500;
const BATCH_FLUSH_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 3000;
let logBuffer = [];
let batchFlushTimer = null;
let isBatchFlushing = false;

const AXIOM_UNAVAILABLE_BACKOFF_MS = 3 * 1000; // 3 seconds
let axiomSuspendedUntil = 0;

const isAxiomSuspended = () => Date.now() < axiomSuspendedUntil;

const suspendAxiomLogging = () => {
  axiomSuspendedUntil = Date.now() + AXIOM_UNAVAILABLE_BACKOFF_MS;
  axiom = null;
  axiomInitialized = false;
};

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
        // 静默失败
    }
};

/**
 * 可 mock 的延迟函数，用于测试
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
export const delay = (ms) => {
  if (process.env.NODE_ENV === 'test' || ms <= 0) {
    return Promise.resolve();
  }

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

const handleAxiomError = (error) => {
  if (!error) return;
  const message = String(error.message || '');
  const lowerMessage = message.toLowerCase();
  const isJsonParseError =
    error instanceof SyntaxError &&
    message.includes('Unexpected end of JSON input');

  if (isJsonParseError) {
    return;
  }

  if (lowerMessage.includes('unavailable')) {
    suspendAxiomLogging();
  }

  originalConsoleError.call(console, 'Axiom ingest error:', message);
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
        onError: handleAxiomError
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
        onError: handleAxiomError
      });
    }
  } catch (error) {
    // 移除 console.error
  } finally {
    axiomInitialized = true;
  }
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
    const lowerErrorMessage = String(error.message || '').toLowerCase();
    if (lowerErrorMessage.includes('unavailable')) {
      suspendAxiomLogging();
    }

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

async function flushLogsBatch() {
  if (isBatchFlushing || !logBuffer.length) {
    return;
  }

  if (batchFlushTimer) {
    clearTimeout(batchFlushTimer);
    batchFlushTimer = null;
  }

  isBatchFlushing = true;
  const batchToSend = logBuffer;
  logBuffer = [];

  try {
    if (!axiom) {
      await initAxiom();
    }

    const dataset = getSafeDatasetName();
    if (!dataset || !axiom) {
      throw new Error('Axiom not properly configured for batch ingest');
    }

    await retryWithDelay(async () => {
      const success = await safeAxiomIngest(dataset, batchToSend);
      if (!success) {
        throw new Error('Axiom ingest returned falsy');
      }
    }, 3, (attempt) => process.env.NODE_ENV === 'test' ? 0 : Math.pow(2, attempt) * 1000);
  } catch (error) {
    originalConsoleError.call(console, 'Axiom batch ingest failed:', error.message);
    for (const payload of batchToSend) {
      fallbackToConsole(payload.level || 'log', payload.message, payload);
    }
  } finally {
    isBatchFlushing = false;
    if (logBuffer.length) {
      scheduleBatchFlush();
    }
  }
}

const scheduleBatchFlush = () => {
  if (batchFlushTimer || !logBuffer.length) {
    return;
  }

  batchFlushTimer = setTimeout(() => {
    batchFlushTimer = null;
    flushLogsBatch();
  }, BATCH_FLUSH_INTERVAL_MS);
};

const queuePayloadForBatch = (payload) => {
  logBuffer.push(payload);

  if (logBuffer.length >= BATCH_MAX_SIZE) {
    void flushLogsBatch();
    return;
  }

  scheduleBatchFlush();
};

export const flushLogBuffer = async () => {
  await flushLogsBatch();
};

const normalizeContext = (context) => {
    if (!context) return {};
    if (typeof context === 'string') {
        return { module: context };
    }
    if (typeof context !== 'object') return {};

    const normalized = {};
    for (const [key, value] of Object.entries(context)) {
        if (value === undefined || value === null) continue;
        normalized[key] = value;
    }
    return normalized;
};

const mergeContext = (baseContext, extraContext) => {
    return { ...baseContext, ...normalizeContext(extraContext) };
};

const fallbackToConsole = (level, message, data) => {
    const fallback = { error: originalConsoleError, warn: originalConsoleWarn, log: originalConsoleLog }[level] || originalConsoleLog;
    fallback.call(console, message, data);
};

const log = async (instanceId, level, message, data = {}, context = {}) => {
  // 确保 data 是一个对象且不是 Error 实例
  let finalData = data;
  if (data && typeof data !== 'object') {
      finalData = { value: data };
  } else if (data instanceof Error) {
      finalData = serializeError(data);
  }

  // 确保版本已初始化
  await initVersion();

  const contextFields = normalizeContext(context);
  if (contextFields.module != null) {
    contextFields.module = String(contextFields.module);
  }

  const modulePrefix = contextFields.module ? `[${contextFields.module}] ` : '';
  const consoleMessage = `[v${version}] ${modulePrefix}${message}`;

  if (isAxiomSuspended()) {
    fallbackToConsole(level, consoleMessage, finalData);
    return;
  }

  if (!axiom) {
    await initAxiom();
  }

  if (!axiom) {
    fallbackToConsole(level, consoleMessage, finalData);
    return;
  }

  // 构建 payload，details 永远是字符串
  // message 使用原始消息（不带前缀），version 和 module 作为独立字段发送到 Axiom
  // 确保 message 是字符串，处理 Error 对象的情况
  const axiomMessage = message instanceof Error ? message.message : String(message);
  const payload = {
    ...contextFields,
    version,
    instanceId,
    level,
    message: axiomMessage,
    timestamp: new Date().toISOString(),
    details: serializeToString(finalData) // ✅ 永远字符串，已处理循环引用和特殊值
  };

  // 特殊处理 Error 对象，提取关键信息到独立字段（但要确保是字符串）
  const errObj = finalData instanceof Error ? finalData : (finalData.error instanceof Error ? finalData.error : null);
  if (errObj) {
    payload.error_name = String(errObj.name).substring(0, 100);
    payload.error_message = String(errObj.message).substring(0, 200);
  } else if (finalData.error) {
    // 处理非 Error 实例的 error 字段
    payload.error_summary = String(finalData.error).substring(0, 200);
  }

  // 额外安全：限制顶层字段，使用更保守的值（50 远低于 257）
  const finalPayload = limitFields(payload, 50);
  finalPayload._time = finalPayload.timestamp;
  finalPayload.eventId = `${instanceId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  queuePayloadForBatch(finalPayload);
};

const getSafeInstanceId = () => {
    try {
        const id = getInstanceIdFunc();
        if (id && typeof id === 'string' && id.trim() !== '' && id !== 'unknown') {
            return id;
        }
        return localFallbackId;
    } catch (e) {
        return localFallbackId;
    }
};

// Use a simple object with methods for the logger to avoid Proxy issues in tests/production
const configureLogger = (customConfig) => {
    config = { ...config, ...customConfig };
    // 如果提供了 axiom 配置，重置初始化状态以便重新初始化
    if (customConfig.axiom) {
        axiom = null;
        axiomInitialized = false;
    }
};

const isInitialized = () => axiomInitialized;

const canSend = (level) => true;

export const createLogger = (context = {}) => {
    const baseContext = normalizeContext(context);
    return {
        info: (message, data) => log(getSafeInstanceId(), 'info', message, data, baseContext),
        warn: (message, data) => log(getSafeInstanceId(), 'warn', message, data, baseContext),
        error: (message, data) => log(getSafeInstanceId(), 'error', message, data, baseContext),
        debug: (message, data) => {
            // Debug logs should not be output to console when Axiom is not configured
            if (!process.env.AXIOM_TOKEN && (!config || !config.axiom)) return;
            return log(getSafeInstanceId(), 'debug', message, data, baseContext);
        },
        withContext: (extraContext) => createLogger(mergeContext(baseContext, extraContext)),
        withModule: (moduleName) => createLogger(mergeContext(baseContext, { module: moduleName })),
        configure: configureLogger,
        isInitialized,
        canSend
    };
};

export const logger = createLogger();

/**
 * Enable console proxy for Telegram library errors
 * Captures console.error calls from GramJS and routes them to structured logging
 */
let consoleProxyEnabled = false;

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

/**
 * Update original console references
 * This is useful for tests that need to restore console after mocking
 */
export const updateOriginalConsole = () => {
    // This function exists to support test mocking patterns
    // In production, it does nothing but is exported for compatibility
};

// 确保同时支持 named export 和 default export
export default logger;
