/**
 * @file scripts/redis-utils.js
 * @description 从 src/index.js 提取的 Redis 相关实用函数，用于 Node.js 环境测试。
 */

// 检查是否在测试环境
const isTestEnvironment = true; // 在此测试工具中总是 true

// 版本常量 - 在此模拟
const VERSION = 'test-dev';

// 全局状态 - 仅用于 logger
let pendingLogs = [];

// 模拟 OpenTelemetry API，以便 logger 函数不会报错
const noop = () => {};
const mockSpan = {
  addEvent: noop,
  setStatus: noop,
  recordException: noop,
  setAttribute: noop,
};
const mockTracer = {
  startSpan: () => mockSpan,
  getActiveSpan: () => mockSpan,
  withActiveSpan: (span, fn) => fn(span),
};
const mockTrace = {
  getTracer: () => mockTracer,
  getActiveSpan: () => mockSpan,
};
global.trace = mockTrace;

/**
 * 日志记录器 (简化版本，仅用于测试输出)
 */
export const logger = {
  env: 'test',
  version: VERSION,

  configure({ env = 'test' }) {
    this.env = env;
  },

  async info(message, meta = {}, ctx = null) {
    if (console && console.log) {
      console.log(`[INFO] ${message}`, meta);
    }
  },

  async warn(message, meta = {}, ctx = null) {
    if (console && console.warn) {
      const errorMeta = meta.error instanceof Error ? { stack: meta.error.stack, message: meta.error.message } : meta;
      console.warn(`[WARN] ${message}`, errorMeta);
    }
  },

  async error(message, meta = {}, ctx = null) {
    if (console && console.error) {
      const errorMeta = meta.error instanceof Error ? { stack: meta.error.stack, message: meta.error.message } : meta;
      console.error(`[ERROR] ${message}`, errorMeta);
    }
  },

  async debug(message, meta = {}, ctx = null) {
    if (this.env === 'development' || this.env === 'test') {
      if (console && console.debug) {
        console.debug(`[DEBUG] ${message}`, meta);
      }
    }
  }
};

// 导入 Redis client
import { createRedis } from 'redis-on-workers';

// 以下是直接从 src/index.js 复制的 Redis 相关函数
// 注意：移除了对 ctx 的依赖，因为在 Node.js 环境中 ctx 是 Workers 特有的
// 并且已经通过 mockEnv 传递了环境配置

let redisClient = null;

/**
 * 获取 Redis 客户端实例
 * 优化了连接配置以减少 ECONNRESET 错误
 */
export async function getRedisClient(env, ctx) {
  if (redisClient) return redisClient;

  const urlStr = env.NF_REDIS_URL;
  if (!urlStr) throw new Error('NF Redis URL not configured');

  let redisOptions = {
    url: urlStr,
    password: env.NF_REDIS_PASSWORD,
    // 优化连接配置
    connectTimeout: 10000, // 10秒连接超时
    commandTimeout: 10000, // 10秒命令超时
    retryDelayOnFailover: 100, // 100ms 重试延迟
    socket: {
      keepAlive: 30000, // 30秒 keepalive
      noDelay: true, // 禁用 Nagle 算法，减少延迟
      connectTimeout: 10000, // 10秒 socket 连接超时
    }
  };

  // 注意：在 redis-on-workers 中，tls 选项可能不被支持或导致类型错误
  // 如果 URL 是 rediss://，库应该自动处理 TLS
  // if (urlStr.startsWith('rediss://')) {
  //   redisOptions.tls = true;
  // }
  
  if (urlStr.startsWith('rediss://')) {
    // 在 Node.js 环境下，如果遇到 SocketError: read ECONNRESET，通常意味着 TLS 握手失败
    // 或服务端拒绝了非授权连接。尝试强制开启 tls 选项并禁用证书验证。
    redisOptions.tls = {
      servername: new URL(urlStr).hostname,
      rejectUnauthorized: false
    };
    console.log(`[DEBUG] Node.js environment detected. Applied TLS workaround for ${redisOptions.tls.servername}`);
  }
  
  try {
    redisClient = createRedis(redisOptions);
    await logger.info('Redis Client 初始化成功', { url: urlStr.replace(/:[^:@]*@/, ':***@') });
    return redisClient;
  } catch (e) {
    await logger.error('Redis Client 初始化失败', { error: e.message });
    throw e;
  }
}

/**
 * 带重试逻辑的 Redis 命令执行辅助函数
 * 专门处理 ECONNRESET, ETIMEDOUT, SocketError 等网络错误
 */
async function retryRedisCommand(client, command, args, maxRetries = 3) {
  const errorsToRetry = ['ECONNRESET', 'ETIMEDOUT', 'SocketError', 'network error'];
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const start = Date.now();
      const result = await client.send(command, ...args);
      const duration = Date.now() - start;
      
      // 记录成功执行
      if (command !== 'PING') { // PING 可能太频繁
        await logger.debug(`Redis ${command} 成功`, { duration: `${duration}ms`, attempt });
      }
      
      return result;
    } catch (e) {
      const errorMsg = e.message || String(e);
      const isRetryable = errorsToRetry.some(err => errorMsg.includes(err));
      
      lastError = e;
      
      if (!isRetryable || attempt === maxRetries) {
        // 如果不是可重试错误，或者是最后一次尝试，直接抛出
        if (command !== 'PING') {
          await logger.warn(`Redis ${command} 失败 (尝试 ${attempt}/${maxRetries})`, { error: errorMsg });
        }
        throw e;
      }
      
      // 计算指数退避延迟 (100ms, 200ms, 400ms...)
      const delay = 100 * Math.pow(2, attempt - 1);
      if (command !== 'PING') {
        await logger.info(`Redis ${command} 重试中 (尝试 ${attempt}/${maxRetries})`, { error: errorMsg, delay: `${delay}ms` });
      }
      
      // 等待重试延迟
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

export async function executeRedis(operation, env, key, value = null) {
  const client = await getRedisClient(env, null);
  
  if (operation === '_redis_get') {
    try {
      const result = await retryRedisCommand(client, 'GET', [key]);
      if (result === null) return null;
      return String(result);
    } catch (e) {
      await logger.warn(`NF Redis GET key=${key} failed`, { error: e.message });
      throw e;
    }
  } else if (operation === '_redis_put') {
    try {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      await retryRedisCommand(client, 'SET', [key, valStr]);
      return true;
    } catch (e) {
      await logger.warn(`NF Redis PUT key=${key} failed`, { error: e.message });
      throw e;
    }
  } else if (operation === 'del') { // 支持 del 命令用于清理
    try {
      await retryRedisCommand(client, 'DEL', [key]);
      return true;
    } catch (e) {
      await logger.warn(`NF Redis DEL key=${key} failed`, { error: e.message });
      throw e;
    }
  }
  throw new Error(`Unsupported Redis operation: ${operation}`);
}

export async function executeRedisScan(env, prefix) {
  const client = await getRedisClient(env, null);
  const keys = [];
  let cursor = '0';
  
  do {
    const res = await retryRedisCommand(client, 'SCAN', [cursor, 'MATCH', `${prefix}*`, 'COUNT', '100']);
    if (!Array.isArray(res) || res.length !== 2) {
      throw new Error('Invalid SCAN response');
    }
    
    cursor = String(res[0]);
    const batchKeys = res[1];
    
    if (Array.isArray(batchKeys)) {
      for (const k of batchKeys) {
        keys.push({ name: String(k) });
      }
    }
  } while (cursor !== '0');
  
  return { keys };
}

export async function checkRedisHealth(env, ctx) {
  try {
    const client = await getRedisClient(env, null);
    // 健康检查前短暂延迟，避免连接刚建立时的不稳定
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const res = await retryRedisCommand(client, 'PING', []);
    
    if (res === 'PONG') {
       await logger.info('Redis 健康检查成功');
       return true;
    } else {
       await logger.warn('Redis 健康检查异常', { response: res });
       return false;
    }
  } catch (e) {
    await logger.error('Redis 健康检查连接失败', { error: e.message });
    return false;
  }
}
