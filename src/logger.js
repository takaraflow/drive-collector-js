import { trace, context } from '@opentelemetry/api';

// 全局类型定义（解决 TypeScript 警告）
/** @type {string} */
// 避免 esbuild 替换导致的 variable shadowing 问题
const __VERSION__ = (typeof globalThis !== 'undefined' && globalThis.__VERSION__) || 'dev';

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
  // 在测试环境中也允许配置，用于测试
  if (env.AXIOM_TOKEN && env.AXIOM_DATASET) {
    baseLoggerConfig.dataset = env.AXIOM_DATASET;
    baseLoggerConfig.token = env.AXIOM_TOKEN;
    baseLoggerConfig.orgId = env.AXIOM_ORG_ID || null;
    baseLoggerConfig.env = env.NODE_ENV || 'production';
  }
}

/**
 * 数据清洗函数 - Axiom 日志保底逻辑
 * 限制单条日志的字段数量、字符串长度和对象深度
 * @param {any} val - 要清洗的值
 * @param {number} depth - 当前深度
 * @param {Object} context - 上下文（用于跟踪字段计数）
 * @returns {any} - 清洗后的值
 */
function sanitizeLogData(val, depth = 0, context = { fieldCount: 0 }) {
  try {
    // 限制最大深度为 3 层
    if (depth > 3) {
      return "[DEPTH_EXCEEDED]";
    }

    // 处理 null 和 undefined
    if (val === null || val === undefined) {
      return val;
    }

    // 处理字符串 - 限制长度为 10,000 字符
    if (typeof val === 'string') {
      if (val.length > 10000) {
        return val.substring(0, 10000) + "...[TRUNCATED]";
      }
      return val;
    }

    // 处理数字、布尔值等基本类型
    if (typeof val !== 'object') {
      return val;
    }

    // 处理数组
    if (Array.isArray(val)) {
      return val.map(item => sanitizeLogData(item, depth + 1, context));
    }

    // 处理对象 - 限制字段数量为 50 个
    if (typeof val === 'object') {
      // 处理 Date 对象
      if (val instanceof Date) {
        return val.toISOString();
      }
      
      // 处理数组
      if (Array.isArray(val)) {
        return val.map(item => sanitizeLogData(item, depth + 1, context));
      }
      
      const cleaned = {};
      
      // 优先保留关键字段（不计入 50 个限制）
      const priorityKeys = ['timestamp', 'level', 'message', 'requestId'];
      const priorityData = {};
      const otherData = {};

      for (const key in val) {
        if (priorityKeys.includes(key)) {
          priorityData[key] = val[key];
        } else {
          otherData[key] = val[key];
        }
      }

      // 先添加优先字段
      for (const key in priorityData) {
        cleaned[key] = sanitizeLogData(priorityData[key], depth + 1, context);
      }

      // 再添加其他字段，但不超过 50 个总数
      let fieldCount = 0;
      for (const key in otherData) {
        if (fieldCount >= 50) {
          cleaned['_truncated_fields'] = true;
          break;
        }
        cleaned[key] = sanitizeLogData(otherData[key], depth + 1, context);
        fieldCount++;
      }

      return cleaned;
    }

    // 处理其他类型（如 Function 等）
    return String(val);
  } catch (error) {
    // 如果清洗过程出错，返回一个简化的错误信息
    return "[SANITATION_ERROR]";
  }
}

/**
 * 计算字符串的字节大小
 * @param {string} str - 字符串
 * @returns {number} - 字节大小
 */
function getByteSize(str) {
  return new Blob([str]).size;
}

/**
 * 发送日志到 Axiom
 * @param {Object} logData - 日志数据
 * @param {Array<Object>} logBuffer - 当前请求的日志缓冲
 * @param {Object} ctx - Cloudflare context (可选)
 */
async function sendToAxiom(logData, logBuffer, ctx = null) {
  const requestId = ctx?._axiomDebugRequestId || 'unknown';

  // 应用清洗逻辑 - 在所有环境中都执行，确保数据安全
  let sanitizedData;
  try {
    sanitizedData = sanitizeLogData(logData);
  } catch (error) {
    // 如果清洗失败，记录错误并使用原始数据（保底策略）
    console.error(`[Axiom] Sanitization failed: ${error.message}`);
    sanitizedData = {
      level: logData.level || 'error',
      message: '[SANITATION_ERROR]',
      timestamp: new Date().toISOString(),
      version: VERSION
    };
  }

  if (isTestEnvironment) {
    // 测试环境：输出到控制台供测试用例捕获
    const level = sanitizedData.level || 'info';
    const message = sanitizedData.message;
    const data = { ...sanitizedData };
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

  // 将清洗后的日志添加到缓冲
  console.log(`[AXIOM_DEBUG] ${requestId}: sendToAxiom - adding ${sanitizedData.level} log to buffer, current size=${logBuffer.length}`);
  logBuffer.push(sanitizedData);
}

/**
 * 刷新日志缓冲，将所有待发送日志发送到 Axiom
 * @param {Array<Object>} logBuffer - 当前请求的日志缓冲
 * @param {Object} ctx - Cloudflare context (可选)
 */
export async function flushLogs(logBuffer, ctx = null) {
  // 1. 基础防御检查
  if (!baseLoggerConfig.token || !baseLoggerConfig.dataset) {
    // 在测试环境中，如果没有配置，仍然处理缓冲区但不发送
    if (!isTestEnvironment) {
      console.warn('[Axiom] Config missing, skipping flush');
    }
    
    // 即使没有配置，也要清空缓冲区防止内存泄漏
    if (logBuffer && logBuffer.length > 0) {
      logBuffer.length = 0;
    }
    return;
  }

  if (!logBuffer || logBuffer.length === 0) {
    return;
  }

  // 2. 关键步骤：冻结并清空缓冲区 (防止引用问题)
  const logsToSend = [...logBuffer];
  logBuffer.length = 0; // 立即清空原数组

  console.log(`[Axiom] Preparing to send ${logsToSend.length} events...`);

  // 3. 应用清洗逻辑（双重保险，确保缓冲区中的数据也是清洗过的）
  const sanitizedLogs = logsToSend.map(log => {
    try {
      return sanitizeLogData(log);
    } catch (error) {
      // 如果单条日志清洗失败，返回一个简化的错误日志
      return {
        level: 'error',
        message: '[LOG_SANITIZE_FAILED]',
        timestamp: new Date().toISOString(),
        version: VERSION
      };
    }
  });

  // 4. 序列化并检查总体积
  let batchBody;
  try {
    batchBody = JSON.stringify(sanitizedLogs);
  } catch (error) {
    // 如果序列化失败（如循环引用），记录错误并停止
    console.error(`[Axiom] Batch serialization failed: ${error.message}`);
    return;
  }

  const batchSize = getByteSize(batchBody);
  const maxBatchSize = 2 * 1024 * 1024; // 2MB

  console.log(`[Axiom] Batch size: ${(batchSize / 1024 / 1024).toFixed(2)}MB`);

  // 5. 体积超限处理
  if (batchSize > maxBatchSize) {
    console.warn(`[Axiom] Batch size ${batchSize} exceeds limit ${maxBatchSize}. Applying truncation...`);

    // 策略：按顺序截断，直到体积符合要求
    let truncatedLogs = [];
    let currentSize = 0;
    
    for (const log of sanitizedLogs) {
      const logStr = JSON.stringify(log);
      const logSize = getByteSize(logStr);
      
      // 如果加上当前日志会超限，且已经有日志了，则停止添加
      if (currentSize + logSize > maxBatchSize && truncatedLogs.length > 0) {
        // 添加一条截断警告日志
        truncatedLogs.push({
          level: 'warn',
          message: '[BATCH_TRUNCATED]',
          details: `Original count: ${sanitizedLogs.length}, sent: ${truncatedLogs.length}`,
          timestamp: new Date().toISOString(),
          version: VERSION
        });
        break;
      }
      
      truncatedLogs.push(log);
      currentSize += logSize;
    }

    // 如果截断后还是太大，只保留第一条并添加警告
    if (truncatedLogs.length === 0 || getByteSize(JSON.stringify(truncatedLogs)) > maxBatchSize) {
      console.error(`[Axiom] Batch still too large after truncation. Dropping all logs.`);
      return;
    }

    batchBody = JSON.stringify(truncatedLogs);
    console.log(`[Axiom] Truncated to ${truncatedLogs.length} logs, new size: ${(getByteSize(batchBody) / 1024 / 1024).toFixed(2)}MB`);
  }

  // 6. 构造请求参数
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

  // 7. 执行原生 Fetch
  const uploadTask = fetch(url, {
    method: 'POST',
    headers: headers,
    body: batchBody
  })
  .then(async (res) => {
    // 8. 调试回显 (查看 CF 实时日志)
    if (res.ok) {
      console.log(`[Axiom] Success: ${res.status} OK. Ingested batch.`);
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

  // 9. 生命周期管理 (防止 Worker 提前结束)
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(uploadTask);
  } else {
    // 本地测试环境可能没有 waitUntil，使用 await
    // 在测试环境中，我们需要确保 fetch 被调用
    if (isTestEnvironment) {
      await uploadTask;
    } else {
      await uploadTask;
    }
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

// 导出清洗函数供测试使用
export { sanitizeLogData };

// 导出配置函数供外部使用
export default logger;