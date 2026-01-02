import { Axiom } from '@axiomhq/js';
import { trace } from '@opentelemetry/api';

// 全局类型定义（解决 TypeScript 警告）
/** @type {string} */
const __VERSION__ = typeof globalThis.__VERSION__ !== 'undefined' ? globalThis.__VERSION__ : 'dev';
/** @type {any} */
const jest = typeof globalThis.jest !== 'undefined' ? globalThis.jest : undefined;

// 版本信息
export const VERSION = __VERSION__;
export const isTestEnvironment = process.env.NODE_ENV === 'test' || typeof jest !== 'undefined';

// 全局基础 logger 配置
/** @type {Axiom | null} */
let axiomClient = null;
let baseLoggerConfig = {
  dataset: null,
  token: null,
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
    baseLoggerConfig.env = env.NODE_ENV || 'production';
    
    axiomClient = new Axiom({
      token: env.AXIOM_TOKEN,
      orgId: env.AXIOM_ORG_ID
    });
  }
}

/**
 * 发送日志到 Axiom
 * @param {Object} logData - 日志数据
 * @param {Object} ctx - Cloudflare context (可选)
 */
async function sendToAxiom(logData, ctx = null) {
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
      console.log(message, data);
    } else if (level === 'warn') {
      console.warn(message, data);
    } else if (level === 'error') {
      console.error(message, data);
    } else if (level === 'debug') {
      console.debug(message, data);
    }
    return;
  }

  if (!axiomClient || !baseLoggerConfig.dataset) {
    // 未配置 Axiom 时，输出到控制台
    console.log(JSON.stringify(logData));
    return;
  }

  try {
    // Axiom 的 ingest 方法是异步的，但返回 void
    // 我们需要手动处理 flush 来确保日志发送
    axiomClient.ingest(baseLoggerConfig.dataset, [logData]);
    
    if (ctx && ctx.waitUntil) {
      // 使用 ctx.waitUntil 确保日志发送不阻塞响应
      ctx.waitUntil(
        axiomClient.flush().catch(err => {
          console.error('Axiom 日志发送失败:', err.message);
        })
      );
    } else {
      // 没有 context 时同步发送（主要用于测试）
      await axiomClient.flush();
    }
  } catch (error) {
    console.error('Axiom 日志发送失败:', error.message);
  }
}

/**
 * 添加 OpenTelemetry 事件到当前 span
 * @param {string} level - 日志级别
 * @param {string} message - 消息
 * @param {Object} data - 附加数据
 */
function addOtelEvent(level, message, data = {}) {
  try {
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent('log', {
        'log.level': level,
        'log.message': message,
        'log.data': JSON.stringify(data),
        'log.version': VERSION,
        'log.module': data.module || 'unknown'
      });
    }
  } catch (error) {
    // OpenTelemetry 相关错误不影响主流程
  }
}

/**
 * 创建日志记录器工厂函数
 * @param {Object} baseConfig - 基础配置
 * @param {Object} bindings - 绑定的上下文数据
 */
function createLoggerFactory(baseConfig, bindings = {}) {
  const logger = {
    // 基础属性
    version: VERSION,
    env: baseConfig.env || 'production',
    bindings: bindings,

    /**
     * 记录 info 级别日志
     */
    info: async function(message, data = {}, ctx = null) {
      const logData = {
        level: 'info',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      
      addOtelEvent('info', message, logData);
      await sendToAxiom(logData, ctx);
      
      // 开发环境同时输出到控制台
      if (baseConfig.env === 'development' && !isTestEnvironment) {
        console.log(`[INFO] ${message}`, { ...bindings, ...data, version: VERSION });
      }
    },

    /**
     * 记录 warn 级别日志
     */
    warn: async function(message, data = {}, ctx = null) {
      const logData = {
        level: 'warn',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      
      addOtelEvent('warn', message, logData);
      await sendToAxiom(logData, ctx);
      
      if (baseConfig.env === 'development' && !isTestEnvironment) {
        console.warn(`[WARN] ${message}`, { ...bindings, ...data, version: VERSION });
      }
    },

    /**
     * 记录 error 级别日志
     */
    error: async function(message, data = {}, ctx = null) {
      const logData = {
        level: 'error',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      
      addOtelEvent('error', message, logData);
      await sendToAxiom(logData, ctx);
      
      if (baseConfig.env === 'development' && !isTestEnvironment) {
        console.error(`[ERROR] ${message}`, { ...bindings, ...data, version: VERSION });
      }
    },

    /**
     * 记录 debug 级别日志
     */
    debug: async function(message, data = {}, ctx = null) {
      const logData = {
        level: 'debug',
        message,
        ...bindings,
        ...data,
        version: VERSION,
        timestamp: new Date().toISOString()
      };
      
      addOtelEvent('debug', message, logData);
      
      // Debug 日志只在开发环境或测试环境发送到 Axiom
      if (baseConfig.env === 'development' || isTestEnvironment) {
        await sendToAxiom(logData, ctx);
        
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
      return createLoggerFactory(baseConfig, mergedBindings);
    },

    /**
     * 配置更新
     */
    configure: function(config) {
      if (config.env) {
        baseConfig.env = config.env;
        logger.env = config.env;
      }
    }
  };

  return logger;
}

// 基础 logger 实例
export const logger = createLoggerFactory(baseLoggerConfig);

// 导出配置函数供外部使用
export default logger;