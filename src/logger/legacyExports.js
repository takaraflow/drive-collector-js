/**
 * 向后兼容的日志导出
 * 保持现有 API 不变，但使用 CF Workers 优化的内部实现
 */

// 导入优化的工厂函数
import { createLoggerFactory as createOptimizedLoggerFactory } from './index.js';

// 创建全局日志管理器
let globalManager = null;

// 获取版本信息
const VERSION = typeof globalThis !== 'undefined' && globalThis.VERSION ? globalThis.VERSION : 'dev';

// 基础环境检查
function normalizeEnvName(env) {
  if (!env) return 'prod';
  
  const envMap = {
    'development': 'dev',
    'dev': 'dev',
    'staging': 'pre',
    'pre': 'pre',
    'production': 'prod',
    'prod': 'prod'
  };
  
  return envMap[env.toLowerCase()] || 'prod';
}

function isDevEnv(env) {
  return ['dev', 'development'].includes(normalizeEnvName(env));
}

// 检查测试环境
const isTestEnvironment = typeof globalThis !== 'undefined' && globalThis.VITEST === 'true';

// CF Workers 全局配置
const baseLoggerConfig = {
  debugEnabled: typeof globalThis !== 'undefined' && globalThis.DEBUG_LOGS === 'true',
  token: typeof globalThis !== 'undefined' ? globalThis.AXIOM_TOKEN : null,
  dataset: typeof globalThis !== 'undefined' ? globalThis.AXIOM_DATASET : 'cf-worker-logs',
  orgId: typeof globalThis !== 'undefined' ? globalThis.AXIOM_ORG_ID : null
};

// 创建基础 logger 实例（使用优化的工厂）
export const logger = createOptimizedLoggerFactory({
  env: normalizeEnvName(process?.env?.NODE_ENV || 'prod'),
  version: VERSION
});

// 导出工具函数
export function configureBaseLoggerTransport(config) {
  if (config.token) {
    baseLoggerConfig.token = config.token;
    globalThis.AXIOM_TOKEN = config.token;
  }
  if (config.dataset) {
    baseLoggerConfig.dataset = config.dataset;
    globalThis.AXIOM_DATASET = config.dataset;
  }
}

// OpenTelemetry 集成（简化版本）
export function addOtelEvent(level, message, data, span) {
  // CF Workers 环境下轻量化处理
  if (span && typeof span.addEvent === 'function') {
    span.addEvent({
      name: `log.${level}`,
      attributes: {
        'log.message': message,
        'log.level': level,
        ...Object.fromEntries(Object.entries(data).map(([k, v]) => [`log.${k}`, String(v)]))
      }
    });
  }
}

// 导出向后的 sendToAxiom 函数
export async function sendToAxiom(logData, logBuffer, ctx = null) {
  const requestId = ctx?._axiomDebugRequestId || 'unknown';

  // 应用清洗逻辑
  let sanitizedData;
  try {
    // 动态导入以避免循环依赖
    const { sanitizeLogData } = await import('./index.js');
    sanitizedData = sanitizeLogData(logData);
  } catch (error) {
    console.error(`[Axiom] Sanitization failed: ${error.message}`);
    sanitizedData = {
      level: logData.level || 'error',
      message: '[SANITIZATION_ERROR]',
      timestamp: new Date().toISOString(),
      version: VERSION
    };
  }

  // 轻量级缓冲区操作
  if (logBuffer && Array.isArray(logBuffer)) {
    logBuffer.push(sanitizedData);
    if (logBuffer.length > 1000) {
      logBuffer.splice(0, logBuffer.length - 1000);
    }
  } else if (logBuffer && typeof logBuffer.push === 'function') {
    logBuffer.push(sanitizedData);
  }
}

// 导出 sanitizeLogData（动态避免循环）
export async function sanitizeLogData(val, depth = 0, context = { fieldCount: 0 }) {
  // 动态导入实现
  const { sanitizeLogData: sanitizeLogDataImpl } = await import('./index.js');
  return sanitizeLogDataImpl(val, depth, context);
}

// 导出全局日志刷新函数
export async function flushLogs(logBuffer) {
  // 基础防御检查
  if (!baseLoggerConfig.token || !baseLoggerConfig.dataset) {
    console.warn('⚠️ [Axiom] 配置缺失，跳过刷新');
    
    if (logBuffer) {
      if (logBuffer.length > 0) {
        logBuffer.length = 0;
      }
    }
    
    return Promise.resolve(null);
  }

  if (!logBuffer) {
    return;
  }

  const logsToSend = [...logBuffer];
  if (logsToSend.length === 0) return;

  // 立即清空缓冲区
  logBuffer.length = 0;

  // CF Workers 优化：直接发送，不等待
  if (isTestEnvironment) {
    console.log(`[Axiom] Test mode: Skipping network send, processed ${logsToSend.length} logs`);
    return;
  }

  const batchBody = JSON.stringify(logsToSend);
  const url = `https://api.axiom.co/v1/datasets/${baseLoggerConfig.dataset}/ingest`;
  
  const headers = {
    'Authorization': `Bearer ${baseLoggerConfig.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'cf-worker-custom-logger/1.0'
  };

  if (baseLoggerConfig.orgId) {
    headers['X-Axiom-Org-Id'] = baseLoggerConfig.orgId;
  }

  // 使用 waitUntil 进行非阻塞发送
  const uploadTask = fetch(url, {
    method: 'POST',
    headers,
    body: batchBody
  });

  if (typeof ctx !== 'undefined' && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(uploadTask.catch(error => {
      console.error(`[Axiom] Global buffer upload failed: ${error.message}`);
    }));
  }

  uploadTask.catch(error => {
    console.error(`[Axiom] Global buffer Network Error: ${error.message}`);
  });
}

// 版本和环境访问器
export { VERSION };
export function updateVersionFromEnv() {
  if (typeof globalThis !== 'undefined' && VERSION) {
    globalThis.VERSION = VERSION;
  }
}

export const isTestEnvironmentVar = isTestEnvironment;