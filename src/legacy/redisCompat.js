/**
 * Redis 兼容层
 * 提供向后兼容的 Redis 操作和故障转移逻辑
 */

import { logger } from '../logger.js';

/**
 * 获取提供者优先级 (使用 CACHE_PROVIDERS)
 * @param {Object} env - 环境变量
 * @returns {string[]} 提供者优先级数组
 */
function getProviderPriority(env) {
  const prios = [];
  if (env && env.KV_STORAGE) prios.push('cloudflare');
  if (env && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) prios.push('upstash');
  return prios;
}

/**
 * Upstash Redis GET（用于故障转移）
 * @param {Object} env - 环境变量
 * @param {string} key - 键名
 * @returns {Promise<any>} 获取的值
 */
async function upstash_get(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
  });

  if (response.status === 404) {
    await response.body.cancel();
    return null;
  }

  if (!response.ok) {
    throw new Error(`Upstash Get Error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.result;
}

/**
 * 执行 Upstash Redis Scan 操作
 * P1修复：添加最大迭代次数限制和超时保护
 * @param {Object} env - 环境变量
 * @param {string} prefix - 前缀
 * @returns {Promise<Object>} 扫描结果
 */
async function executeUpstashScan(env, prefix) {
  // 在测试环境中，如果没有 logger，使用 mock logger 避免错误
  const executeUpstashScanLogger = (typeof logger !== 'undefined' && logger.child) ? logger.child({ module: 'executeUpstashScan' }) : {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {}
  };
  const baseUrl = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!baseUrl || !token) {
    throw new Error('Upstash Redis not configured');
  }

  let keys = [];
  let cursor = 0;
  const start = Date.now();
  const maxIterations = 100; // P1修复：最大迭代次数限制
  const maxDuration = 30000; // P1修复：最大执行时间 30 秒
  let iterations = 0;
  
  while (iterations < maxIterations) {
    // P1修复：检查超时
    if (Date.now() - start > maxDuration) {
      await executeUpstashScanLogger.warn(`Upstash Scan 超时: prefix=${prefix}, iterations=${iterations}, keysFound=${keys.length}`, {});
      break;
    }
    
    iterations++;
    const url = `${baseUrl}/scan/${cursor}?match=${encodeURIComponent(prefix + '*')}&count=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!res.ok) {
      const duration = Date.now() - start;
      await executeUpstashScanLogger.warn(`Upstash Scan Error: status=${res.status}, duration=${duration}ms`, {});
      throw new Error(`Upstash Scan Error: ${res.status}`);
    }
    
    const data = await res.json();
    if (data.keys) {
      keys.push(...data.keys);
    }
    
    cursor = data.cursor || 0;
    if (cursor === 0) break;
  }
  
  const totalDuration = Date.now() - start;
  await executeUpstashScanLogger.debug(`Upstash Scan: prefix=${prefix} success, keys=${keys.length}, duration=${totalDuration}ms`, {});
  return { keys: keys.map(name => ({ name })) };
}

/**
 * 执行 Redis TLS 操作 (使用 CACHE_PROVIDERS)
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @param {string} operation - 操作类型
 * @param {Object} env - 环境变量
 * @param {string} key - 键名
 * @param {any} value - 值
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<any>} 操作结果
 */
async function executeRedis(cacheService, operation, env, key, value = null, ctx = null, requestLogger = null) {
  // 在测试环境中，如果没有提供 logger，使用 mock logger 避免错误
  let log = requestLogger;
  if (!log) {
    try {
      log = logger.child({ module: 'executeRedis' });
    } catch (e) {
      // 如果 logger.child 不存在或出错，使用 mock logger
      log = {
        debug: async () => {},
        info: async () => {},
        warn: async () => {},
        error: async () => {}
      };
    }
  }

  if (!env.CACHE_PROVIDERS) {
    throw new Error('CACHE_PROVIDERS not configured');
  }

  const service = cacheService;

  const start = Date.now();
  try {
    switch (operation) {
      case '_redis_get':
      case '_kv_get': {
        const result = await service.get(key, 'string', {}, ctx);
        await log.debug(`executeRedis GET (CacheService): key=${key}, result=${result}, duration=${Date.now() - start}ms`, {});
        return result;
      }
      case '_redis_put':
      case '_kv_put': {
        const valStr = typeof value === 'string' ? value : JSON.stringify(value);
        await service.set(key, valStr, 3600, {}, ctx);
        await log.debug(`executeRedis PUT (CacheService): key=${key}, duration=${Date.now() - start}ms`, {});
        return true;
      }
      default:
        throw new Error(`Unsupported Redis operation: ${operation}`);
    }
  } catch (e) {
    await log.error(`executeRedis error (CacheService): ${e.message}`, {});
    throw e;
  }
}

/**
 * 执行 Redis TLS Scan 操作 (使用 CACHE_PROVIDERS)
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @param {Object} env - 环境变量
 * @param {string} prefix - 前缀
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<Object>} 扫描结果
 */
async function executeRedisScan(cacheService, env, prefix, ctx = null, requestLogger = null) {
  // 在测试环境中，如果没有提供 logger，使用 mock logger 避免错误
  const scanLogger = requestLogger || (typeof logger !== 'undefined' ? logger.child({ module: 'executeRedisScan' }) : {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {}
  });

  if (!env.CACHE_PROVIDERS) {
    throw new Error('CACHE_PROVIDERS not configured');
  }

  const service = cacheService;

  const keys = await service.listKeys(prefix, ctx);
  await scanLogger.debug(`executeRedisScan (CacheService): prefix=${prefix}, keysFound=${keys.length}`, {});
  return { keys: keys.map(k => ({ name: k })) };
}

/**
 * 执行操作并支持优先级故障转移
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @param {string} operation - 操作类型
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {...any} args - 其他参数
 * @returns {Promise<any>} 操作结果
 */
async function executeWithPriorityFallback(cacheService, operation, env, ctx, ...args) {
  const lastArg = args[args.length - 1];
  const requestLogger = (lastArg && typeof lastArg.debug === 'function') ? args.pop() : null;
  // 在测试环境中，如果没有提供 logger，使用 mock logger 避免错误
  let log = requestLogger || (typeof logger !== 'undefined' && logger.child ? logger.child({ module: 'executeWithPriorityFallback' }) : {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {}
  });

  // 优先使用 CACHE_PROVIDERS
  if (env && env.CACHE_PROVIDERS) {
    try {
      const service = cacheService;
      switch (operation) {
        case '_kv_get':
        case '_redis_get':
          return await service.get(args[0], 'string', {}, ctx);
        case '_kv_put':
        case '_redis_put':
          return await service.set(args[0], args[1], 3600, {}, ctx);
        case '_kv_list':
          const keys = await service.listKeys(args[0], ctx);
          return { keys: keys.map(k => ({ name: k })) };
        case 'EVAL': {
          const script = args[0];
          const key = args[1];
          const evalArgs = args.slice(2);
          const activeProvider = (service.isFailoverMode && service.fallbackProvider) ? service.fallbackProvider : service.primaryProvider;
          if (!activeProvider) {
            throw new Error('No cache provider available for EVAL');
          }
          if (typeof activeProvider.connect === 'function') {
            await activeProvider.connect();
          }
          if (typeof activeProvider.eval === 'function') {
            return await activeProvider.eval(script, key ? [key] : [], evalArgs);
          }
          if (activeProvider.client && typeof activeProvider.client.send === 'function') {
            const numKeys = key ? 1 : 0;
            const keyArgs = key ? [key] : [];
            return await activeProvider.client.send('EVAL', script, numKeys, ...keyArgs, ...evalArgs);
          }
          throw new Error('Active cache provider does not support EVAL');
        }
        default:
          throw new Error(`Unsupported operation for CacheService: ${operation}`);
      }
    } catch (e) {
      await log.error(`CacheService operation ${operation} failed: ${e.message}`);
      // 如果 CacheService 失败，且没有配置 legacy 变量，则直接抛出
      if (!env.KV_STORAGE && !env.UPSTASH_REDIS_REST_URL) {
        throw e;
      }
      // 否则继续尝试 legacy 逻辑
    }
  }

  // Legacy 逻辑 (向后兼容)
  const providers = getProviderPriority(env);
  const providerOps = {
    'cloudflare': {
      '_kv_get': async () => env.KV_STORAGE.get(args[0]),
      '_kv_put': async () => { await env.KV_STORAGE.put(args[0], args[1]); return true; },
      '_kv_list': async () => env.KV_STORAGE.list({ prefix: args[0] })
    },
    'upstash': {
      '_kv_get': async () => upstash_get(env, args[0]),
      '_kv_put': async () => {
        const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${args[0]}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: args[1] })
        });
        if (!res.ok) throw new Error(`Upstash Put Error: ${res.status}`);
        return true;
      },
      '_kv_list': async () => executeUpstashScan(env, args[0])
    }
  };

  for (const p of providers) {
    if (!providerOps[p][operation]) continue;
    try {
      return await providerOps[p][operation]();
    } catch (e) {
      await log.warn(`Legacy provider ${p} failed for ${operation}: ${e.message}`);
    }
  }

  throw new Error(`All providers failed for ${operation}`);
}

/**
 * 执行操作并支持故障转移（向后兼容）
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @param {string} operation - 操作类型
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {...any} args - 其他参数
 * @returns {Promise<any>} 操作结果
 */
async function executeWithFailover(cacheService, operation, env, ctx, ...args) {
  // 检查args的第一个参数是否是logger（旧调用方式：parentLogger在第4位，现在是args[0]）
  if (args.length > 0 && typeof args[0].debug === 'function') {
    const parentLogger = args.shift();
    return await executeWithPriorityFallback(cacheService, operation, env, ctx, ...args, parentLogger);
  }
  return await executeWithPriorityFallback(cacheService, operation, env, ctx, ...args);
}

/**
 * 带有重试逻辑和超时中断的 Redis 命令执行器
 * @param {Object} client - Redis客户端
 * @param {string} command - 命令
 * @param {Array} args - 参数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} initialDelay - 初始延迟
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<any>} 执行结果
 */
async function retryRedisCommand(client, command, args = [], maxRetries = 3, initialDelay = 100, ctx = null, requestLogger = null) {
    const log = requestLogger || (typeof logger !== 'undefined' ? logger.child({ module: 'retryRedisCommand' }) : {
        debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {}
    });

    const timeout = 15000; // 15秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        log.warn(`Redis command ${command} timed out after ${timeout}ms. Aborting...`);
        controller.abort();
    }, timeout);

    let retries = 0;
    let delay = initialDelay;

    try {
        while (retries < maxRetries) {
            if (controller.signal.aborted) {
                throw new Error('Operation aborted by timeout.');
            }

            try {
                // We cannot pass the signal to client.send directly if the library does not support it.
                // But we can race it against a promise that rejects on abort.
                const abortPromise = new Promise((_, reject) => {
                    controller.signal.addEventListener('abort', () => {
                        reject(new Error('Operation aborted.'));
                    });
                });

                const result = await Promise.race([
                    client.send(command, ...args),
                    abortPromise
                ]);
                
                clearTimeout(timeoutId);
                return result;

            } catch (e) {
                if (controller.signal.aborted) {
                    // If timeout happened, we throw the abort error, which is more specific.
                    // Also, try to clean up the connection.
                    if (client && typeof client.disconnect === 'function') {
                        log.warn(`Attempting to disconnect Redis client due to timeout on command: ${command}`);
                        // Don't await, just fire and forget to avoid blocking.
                        client.disconnect();
                    }
                    throw new Error(`Redis command ${command} timed out after ${timeout}ms`);
                }
                
                const errorMessage = e.message.toLowerCase();
                const isRetryable = errorMessage.includes('econnreset') ||
                                    errorMessage.includes('etimedout') ||
                                    errorMessage.includes('socketer') || 
                                    errorMessage.includes('network error');

                if (isRetryable && retries < maxRetries - 1) {
                    retries++;
                    await log.warn(`Redis command ${command} failed. Retrying... (${retries}/${maxRetries})`, { error: e.message, delay });
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff
                } else {
                    throw e; // Non-retryable error or max retries reached
                }
            }
        }
    } finally {
        clearTimeout(timeoutId);
    }
}


export {
  getProviderPriority,
  upstash_get,
  executeUpstashScan,
  executeRedis,
  executeRedisScan,
  executeWithPriorityFallback,
  executeWithFailover,
  retryRedisCommand
};