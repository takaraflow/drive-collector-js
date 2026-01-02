import { trace, context } from '@opentelemetry/api';

// 全局类型定义（解决 TypeScript 警告）
/** @type {string} */
const __VERSION__ = typeof globalThis.__VERSION__ !== 'undefined' ? globalThis.__VERSION__ : 'dev';
/** @type {any} */
const jest = typeof globalThis.jest !== 'undefined' ? globalThis.jest : undefined;

// 版本信息
export const VERSION = __VERSION__;
export const isTestEnvironment = process.env.NODE_ENV === 'test' || typeof jest !== 'undefined';

// 定义 LoggerContext 类型
/**
 * @typedef {Object} LoggerContext
 * @property {string} env - 环境 (production, development, test)
 * @property {Array<Object>} [logBuffer] - 当前请求的日志缓冲
 */

// 全局基础 logger 配置
let baseLoggerConfig = {
  dataset: null,
  token: null,
  orgId: null,
  env: 'production'
};

/**
 * 配置基础 Logger 传输
 * @param {Object} env - 环境变量
 */
export function configureBaseLoggerTransport(env) {
  if (isTestEnvironment) return;

  if (env.AXIOM_TOKEN && env.AXIOM_DATASET) {
    baseLoggerConfig.dataset = env.AXIOM_DATASET;
    baseLoggerConfig.token = env.AXIOM_TOKEN;
    baseLoggerConfig.orgId = env.AXIOM_ORG_ID || null;
    baseLoggerConfig.env = env.NODE_ENV || 'production';
  }
}

/**
 * 发送日志到 Axiom
 * @param {Object} logData - 日志数据
 * @param {Array<Object>} logBuffer - 当前请求的日志缓冲
 * @param {Object} ctx - Cloudflare context (可选)
 */
async function sendToAxiom(logData, logBuffer, ctx = null) {
  const requestId = ctx?._axiomDebugRequestId || 'unknown';

  if (isTestEnvironment) {
    // 测试环境：输出到控制台供测试用例捕获
    const level = logData.level || 'info';
    const message = logData.message;
    const data = { ...logData };
    delete data.level;
    delete data.message;
    delete data.timestamp;
    delete data.version;

    if (level === 'info') {
      console.log(`[AXIOM_DEBUG] ${requestId}: TEST_LOG ${message}`, data);
    } else if (level === 'warn') {
      console.warn(`[AXIOM_DEBUG] ${requestId}: TEST_LOG ${message}`, data);
    } else if (level === 'error') {
      console.error(`[AXIOM_DEBUG] ${requestId}: TEST_LOG ${message}`, data);
    } else if (level === 'debug') {
      console.debug(`[AXIOM_DEBUG] ${requestId}: TEST_LOG ${message}`, data);
    }
    return;
  }

  // 将日志添加到缓冲
  console.log(`[AXIOM_DEBUG] ${requestId}: sendToAxiom - adding ${logData.level} log to buffer, current size=${logBuffer.length}`);
  logBuffer.push(logData);
}

/**
 * 刷新日志缓冲，将所有待发送日志发送到 Axiom
 * @param {Array<Object>} logBuffer - 当前请求的日志缓冲
 * @param {Object} ctx - Cloudflare context (可选)
 */
export async function flushLogs(logBuffer, ctx = null) {
  // 1. 基础防御检查
  // baseLoggerConfig 需要你在 logger.js 顶部定义好(包含 token, dataset 等)
  if (!baseLoggerConfig.token || !baseLoggerConfig.dataset) {
    console.warn('[Axiom] Config missing, skipping flush');
    return;
  }

  if (!logBuffer || logBuffer.length === 0) {
    return;
  }

  // 2. 关键步骤：冻结并清空缓冲区 (防止引用问题)
  // 必须使用副本发送，因为异步过程中原数组可能会变
  const logsToSend = [...logBuffer];
  logBuffer.length = 0; // 立即清空原数组

  console.log(`[Axiom] Preparing to send ${logsToSend.length} events...`);

  // 3. 构造请求参数
  const url = `https://api.axiom.co/v1/datasets/${baseLoggerConfig.dataset}/ingest`;

  const headers = {
    'Authorization': `Bearer ${baseLoggerConfig.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'cf-worker-custom-logger/1.0'
  };

  // 如果有 Org ID，加上它
  if (baseLoggerConfig.orgId) {
    headers['X-Axiom-Org-Id'] = baseLoggerConfig.orgId;
  }

  // 4. 执行原生 Fetch (这是解决报错的核心)
  // 注意：这里绝对不要传 'cache' 参数
  const uploadTask = fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(logsToSend)
  })
  .then(async (res) => {
    // 5. 调试回显 (查看 CF 实时日志)
    if (res.ok) {
      console.log(`[Axiom] Success: ${res.status} OK. Ingested ${logsToSend.length} logs.`);
    } else {
      // 只有报错时才读取 text，节省资源
      const errText = await res.text();
      console.error(`[Axiom] Failed: Status ${res.status} - ${errText}`);
    }
  })
  .catch((error) => {
    // 捕获网络层面的错误 (如 DNS 解析失败, 连接超时)
    console.error(`[Axiom] Network Error: ${error.message}`);
  });

  // 6. 生命周期管理 (防止 Worker 提前结束)
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(uploadTask);
  } else {
    // 本地测试环境可能没有 waitUntil，使用 await
    await uploadTask;
  }
}

/**
 * 添加 OpenTelemetry 事件到当前 span
 * @param {string} level - 日志级别
 * @param {string} message - 消息
 * @param {Object} data - 附加数据
 * @param {Object} providedSpan - 指定的 span
 */
function addOtelEvent(level, message, data = {}, providedSpan = null) {
  try {
    const activeSpan = providedSpan || trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.addEvent('log', {
        'log.level': level,
        'log.message': message,
        'log.version': VERSION,
        'log.module': data.module || 'unknown',
        ...data
      });
    }
  } catch (error) {
    // OpenTelemetry 相关错误不影响主流程
  }
}

/**
 * 创建日志记录器工厂函数
 * @param {LoggerContext} context - 日志器上下文
 * @param {Object} bindings - 绑定的上下文数据
 */
function createLoggerFactory(context, bindings = {}) {
  const logger = {
    // 基础属性
    version: VERSION,
    env: context.env || 'production',
    bindings: bindings,

    /**
     * 记录 info 级别日志
     */
    info: async function(message, data = {}, span = null, ctx = null) {
      const logData = {
        level: 'info',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };

      addOtelEvent('info', message, logData, span);
      await sendToAxiom(logData, context.logBuffer, ctx);

      // 开发环境同时输出到控制台
      if (context.env === 'development' && !isTestEnvironment) {
        console.log(`[INFO] ${message}`, { ...bindings, ...data, version: VERSION });
      }
    },

    /**
     * 记录 warn 级别日志
     */
    warn: async function(message, data = {}, span = null, ctx = null) {
      const logData = {
        level: 'warn',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };

      addOtelEvent('warn', message, logData, span);
      await sendToAxiom(logData, context.logBuffer, ctx);

      if (context.env === 'development' && !isTestEnvironment) {
        console.warn(`[WARN] ${message}`, { ...bindings, ...data, version: VERSION });
      }
    },

    /**
     * 记录 error 级别日志
     */
    error: async function(message, data = {}, span = null, ctx = null) {
      const logData = {
        level: 'error',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };

      addOtelEvent('error', message, logData, span);
      await sendToAxiom(logData, context.logBuffer, ctx);

      if (context.env === 'development' && !isTestEnvironment) {
        console.error(`[ERROR] ${message}`, { ...bindings, ...data, version: VERSION });
      }
    },

    /**
     * 记录 debug 级别日志
     */
    debug: async function(message, data = {}, span = null, ctx = null) {
      const logData = {
        level: 'debug',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };

      addOtelEvent('debug', message, logData, span);

      // Debug 日志只在开发环境或测试环境添加到缓冲
      if (context.env === 'development' || isTestEnvironment) {
        await sendToAxiom(logData, context.logBuffer, ctx);

        if (!isTestEnvironment) {
          console.debug(`[DEBUG] ${message}`, { ...bindings, ...data, version: VERSION });
        }
      }
    },

    /**
     * 创建子日志记录器
     */
    child: function(bindings) {
      const mergedBindings = { ...logger.bindings, ...bindings };
      const newContext = { ...context };
      if (bindings.logBuffer !== undefined) {
        newContext.logBuffer = bindings.logBuffer;
      }
      return createLoggerFactory(newContext, mergedBindings);
    },

    /**
     * 配置更新
     */
    configure: function(config) {
      if (config.env) {
        context.env = config.env;
        logger.env = config.env;
      }
    }
  };

  return logger;
}

// 基础 logger 实例
export const logger = createLoggerFactory({ env: baseLoggerConfig.env, logBuffer: [] }); // 初始 logger 实例带有自己的缓冲

// 导出配置函数供外部使用
export default logger;