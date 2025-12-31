/**
 * Cloudflare Worker - QStash Webhook Load Balancer with Axiom OpenTelemetry
 * 负载均衡器，接收QStash Webhook，转发到活跃实例
 */

// 检查是否在测试环境
const isTestEnvironment = typeof process !== 'undefined' && process.env && (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined);

// 全局状态
let currentProvider = 'cloudflare';
let failureCount = 0;
let lastFailureTime = 0;
let failoverReason = '';
let pendingLogs = []; // Per-request logs for native Axiom ingest

// 常量
const ROUND_ROBIN_KEY = 'lb:round_robin_index';
const HEARTBEAT_TIMEOUT = 15 * 60 * 1000; // 15分钟

// 静态导入 OpenTelemetry API
import { trace } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';
// 静态导入 QStash Receiver（生产环境使用）
import { Receiver } from '@upstash/qstash';

/**
 * 稳健的 JSON 解析函数，支持自动修复无引号键
 */
function safeJsonParse(data, context = '') {
  if (data === null || data === undefined) return null;
  if (typeof data === 'object') return data;

  try {
    return JSON.parse(data);
  } catch (e) {
    try {
      let fixedData = data.trim();
      if (fixedData.startsWith('{') && fixedData.endsWith('}')) {
        fixedData = fixedData.slice(1, -1);
      }
      fixedData = fixedData.replace(/(^|[{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      fixedData = `{${fixedData}}`;
      return JSON.parse(fixedData);
    } catch (fixError) {
      return null;
    }
  }
}

/**
 * 检测缓存提供者
 */
function detectCacheProvider(env) {
  if (env.CACHE_PROVIDER) return env.CACHE_PROVIDER;
  if (env.CF_CACHE_NAMESPACE_ID) return 'cloudflare';
  if (env.NF_REDIS_URL) return 'nf-redis';
  return 'upstash';
}

/**
 * 日志记录器
 */
const logger = {
  env: 'production',

  configure({ env = 'production' }) {
    this.env = env;
  },

  async info(message, meta = {}, ctx = null) {
    const span = trace.getActiveSpan();
    if (span) {
      const attributes = {
        'service.instance.id': "load_balancing",
        ...meta,
        'log.level': 'info',
        'service.name': 'lb-worker-js'
      };
      span.addEvent(message, attributes);
    }
    // Push to pending logs for native Axiom ingest
    if (typeof pendingLogs !== 'undefined') {
      const logEntry = {
        level: 'info',
        message,
        timestamp: new Date().toISOString(),
        service: 'lb-worker-js',
        'service.instance.id': 'load_balancing',
        env: this.env,
        ...meta
      };
      pendingLogs.push(logEntry);
    }
    // 使用 console，测试环境会 mock 它
    if (console && console.log) {
      console.log(`INFO: ${message}`, meta);
    }
  },

  async warn(message, meta = {}, ctx = null) {
    const span = trace.getActiveSpan();
    if (span) {
      span.setStatus({ code: 1, message: message });
      span.setAttribute('log.level', 'warn');
      const attributes = {
        'service.instance.id': "load_balancing",
        ...meta,
        'log.level': 'warn',
        'service.name': 'lb-worker-js'
      };
      span.addEvent(message, attributes);
    }
    // Push to pending logs for native Axiom ingest
    if (typeof pendingLogs !== 'undefined') {
      const logEntry = {
        level: 'warn',
        message,
        timestamp: new Date().toISOString(),
        service: 'lb-worker-js',
        'service.instance.id': 'load_balancing',
        env: this.env,
        ...meta
      };
      pendingLogs.push(logEntry);
    }
    // 使用 console，测试环境会 mock 它
    if (console && console.warn) {
      console.warn(`WARN: ${message}`, meta);
    }
  },

  async error(message, meta = {}, ctx = null) {
    const span = trace.getActiveSpan();
    if (span) {
      const error = message instanceof Error ? message : new Error(message);
      span.recordException(error);
      span.setStatus({ code: 2, message: error.message });
      const attributes = {
        'service.instance.id': "load_balancing",
        ...meta,
        'log.level': 'error',
        'error.message': error.message,
        'error.stack': error.stack,
        'service.name': 'lb-worker-js'
      };
      span.addEvent('error', attributes);
    }
    // Push to pending logs for native Axiom ingest
    if (typeof pendingLogs !== 'undefined') {
      const errorObj = message instanceof Error ? message : new Error(message);
      const logEntry = {
        level: 'error',
        message: errorObj.message,
        timestamp: new Date().toISOString(),
        service: 'lb-worker-js',
        'service.instance.id': 'load_balancing',
        env: this.env,
        'error.message': errorObj.message,
        'error.stack': errorObj.stack,
        ...meta
      };
      pendingLogs.push(logEntry);
    }
    // 使用 console，测试环境会 mock 它
    if (console && console.error) {
      console.error(`ERROR: ${message}`, meta);
    }
  },

  async debug(message, meta = {}, ctx = null) {
    if (this.env === 'development') {
      // 使用 console，测试环境会 mock 它
      if (console && console.debug) {
        console.debug(`DEBUG: ${message}`, meta);
      }
    }
  }
};

/**
 * 验证 QStash 签名 - 重构版本
 */
async function verifyQStashSignature(request, env, isGetRequest = false, ctx = null) {
  // 跳过签名验证
  if (env.SKIP_SIGNATURE_VERIFY === 'true') {
    await logger.debug('跳过签名验证', {}, ctx);
    if (isGetRequest) {
      return null;
    }
    const text = await request.text();
    return new TextEncoder().encode(text);
  }

  // 检查密钥配置
  if (!env.QSTASH_CURRENT_SIGNING_KEY) {
    throw new Error('QSTASH_CURRENT_SIGNING_KEY 未设置');
  }

  // 获取签名头
  const signature = request.headers.get('Upstash-Signature');
  if (!signature) {
    throw new Error('Missing Upstash-Signature header');
  }

  // 检测签名类型（JWT 或 HMAC）
  const isJwt = signature.split('.').length === 3;

  // 获取时间戳并检查过期（仅对非 JWT 签名）
  const timestamp = request.headers.get('Upstash-Timestamp');
  if (!isJwt && timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const expWindow = parseInt(env.SIGNATURE_EXPIRATION_WINDOW || '900');
    if (now - parseInt(timestamp) > expWindow) {
      throw new Error('Signature expired');
    }
  }

  // GET/HEAD 请求不读取 body
  if (isGetRequest) {
    return null;
  }

  // 读取 body 数据（支持 mock 和真实 Request）
  let bodyData;
  let bodyString;
  
  if (request.text) {
    // 真实 Request 对象
    bodyString = await request.text();
    bodyData = new TextEncoder().encode(bodyString);
  } else if (request.arrayBuffer) {
    // Mock 对象
    const buffer = await request.arrayBuffer();
    bodyData = new Uint8Array(buffer);
    bodyString = new TextDecoder().decode(bodyData);
  } else {
    throw new Error('Request object must have text() or arrayBuffer() method');
  }

  // 测试环境 mock 验证
  if (isTestEnvironment && typeof globalThis !== 'undefined' && globalThis.__QSTASH_MOCK_VERIFY__) {
    try {
      const isValid = await globalThis.__QSTASH_MOCK_VERIFY__({
        signature,
        body: bodyData, // 测试期望 Uint8Array
        url: request.url,
        clockTolerance: 300
      });
      if (!isValid) throw new Error('Signature verification failed');
      // 返回 Uint8Array 以匹配测试期望
      return bodyData;
    } catch (e) {
      await logger.error('QStash mock 验证失败', { error: e.message }, ctx);
      throw e;
    }
  }

  // 生产环境：使用静态导入的 Receiver
  try {
    const receiver = new Receiver({
      currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY || env.QSTASH_CURRENT_SIGNING_KEY,
    });

    // SDK 期望 string 类型的 body
    const isValid = await receiver.verify({
      signature,
      body: bodyString,
      url: request.url,
      clockTolerance: 300
    });

    if (!isValid) {
      throw new Error('Signature verification failed');
    }

    // 返回 Uint8Array 以匹配测试期望
    return bodyData;
  } catch (e) {
    // 如果是签名验证失败，直接抛出
    if (e.message === 'Signature verification failed') {
      throw e;
    }
    // 其他错误（如密钥无效、格式错误等）
    await logger.error('QStash 验证失败', { error: e.message }, ctx);
    throw new Error(`Signature verification failed: ${e.message}`);
  }
}

/**
 * 解析实例数据
 */
function parseInstanceData(data) {
  if (!data) return null;
  
  try {
    if (typeof data === 'string') {
      data = JSON.parse(data);
    }
    
    return {
      id: data.id,
      url: data.url,
      status: data.status || 'active',
      lastHeartbeat: data.lastHeartbeat || Date.now(),
      region: data.region || 'unknown'
    };
  } catch (e) {
    return null;
  }
}

/**
 * 扫描锁键（用于 leader election 提示）
 */
async function scanLockKeys(env, ctx = null) {
  try {
    const lockPrefixes = ['lock:', 'task:', 'msg_lock:'];
    let lockCount = 0;
    
    for (const prefix of lockPrefixes) {
      try {
        const result = await executeWithFailover('_kv_list', env, ctx, prefix);
        if (result && result.keys) {
          lockCount += result.keys.length;
        }
      } catch (e) {
        // 忽略单个前缀扫描失败
        await logger.debug('锁键扫描失败', { prefix, error: e.message }, ctx);
      }
    }
    
    return lockCount;
  } catch (error) {
    await logger.debug('锁键扫描异常', { error: error.message }, ctx);
    return 0;
  }
}

/**
 * 获取活跃实例
 */
async function getActiveInstances(env, ctx = null) {
  try {
    // 扫描所有契约键前缀
    const prefixes = ['instance:', 'lock:', 'task:', 'msg_lock:'];
    let allKeys = [];
    
    for (const prefix of prefixes) {
      try {
        const result = await executeWithFailover('_kv_list', env, ctx, prefix);
        if (result && result.keys) {
          allKeys.push(...result.keys);
        }
      } catch (e) {
        // 忽略单个前缀扫描失败，继续其他前缀
        await logger.debug('前缀扫描失败', { prefix, error: e.message }, ctx);
      }
    }

    if (allKeys.length === 0) {
      return [];
    }

    const instances = [];
    const now = Date.now();

    // 只处理 instance:* 键，并去重
    const processedInstances = new Set();
    for (const key of allKeys) {
      if (!key.name.startsWith('instance:')) {
        continue;
      }

      // 去重检查
      if (processedInstances.has(key.name)) {
        continue;
      }
      processedInstances.add(key.name);

      try {
        const data = await executeWithFailover('_kv_get', env, ctx, key.name);
        const instance = parseInstanceData(data);

        if (instance && instance.status === 'active') {
          // 检查心跳是否过期
          if (now - instance.lastHeartbeat <= HEARTBEAT_TIMEOUT) {
            instances.push(instance);
          } else {
            await logger.debug('实例已过期', { instanceId: instance.id, lastHeartbeat: instance.lastHeartbeat }, ctx);
          }
        }
      } catch (e) {
        await logger.error('读取实例数据失败', { key: key.name, error: e.message }, ctx);
      }
    }

    // 记录锁键数量（用于 leader election 监控）
    const lockCount = await scanLockKeys(env, ctx);
    if (lockCount > 0) {
      await logger.debug('检测到锁键', { lockCount }, ctx);
    }

    await logger.debug('获取活跃实例', { count: instances.length, totalKeys: allKeys.length }, ctx);
    return instances;
  } catch (error) {
    await logger.error('获取活跃实例失败', { error: error.message }, ctx);
    return [];
  }
}

/**
 * 选择目标实例 (轮询)
 */
async function selectTargetInstance(instances, env, ctx) {
  if (instances.length === 0) {
    return null;
  }

  let currentIndex = 0;
  try {
    const stored = await executeWithFailover('_kv_get', env, ctx, ROUND_ROBIN_KEY);
    currentIndex = stored ? parseInt(stored) : 0;
  } catch (e) {
    await logger.error('轮询索引获取失败', { error: e.message }, ctx);
  }

  const targetIndex = currentIndex % instances.length;
  const targetInstance = instances[targetIndex];

  try {
    await executeWithFailover('_kv_put', env, ctx, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
  } catch (e) {
    await logger.error('轮询索引更新失败', { error: e.message }, ctx);
  }

  return targetInstance;
}

/**
 * 转发请求到目标实例
 */
async function forwardToInstance(instance, normalizedUrl, request, originalBody, ctx = null) {
  const url = new URL(normalizedUrl.href);
  url.host = new URL(instance.url).host;
  url.protocol = new URL(instance.url).protocol;

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('host');

  headers.set('Host', url.host);

  const requestOptions = {
    method: request.method,
    headers: {
      ...Object.fromEntries(headers),
      'X-Forwarded-Host': request.headers.get('Host'),
      'X-Forwarded-Proto': url.protocol.replace(':', ''),
      'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || '',
      'X-Load-Balancer': 'qstash-lb'
    },
    redirect: 'follow'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestOptions.body = originalBody;
  } else {
    // 对于 GET 请求，确保 body 为 undefined 而不是 null
    requestOptions.body = undefined;
  }

  const forwardRequest = new Request(url.toString(), requestOptions);
  const response = await fetch(forwardRequest);

  if (response.status >= 500) {
    await logger.warn('后端返回 5xx 错误', { status: response.status, instanceId: instance.id }, ctx);
  }

  return response;
}

/**
 * 带重试的转发逻辑
 */
async function fetchWithRetry(instances, normalizedUrl, request, env, body, ctx) {
  let lastError;
  let last5xxResponse = null;

  for (const instance of instances) {
    try {
      const response = await forwardToInstance(instance, normalizedUrl, request, body, ctx);
      
      // 4xx 错误：直接透传，不再重试其他实例
      if (response.status >= 400 && response.status < 500) {
        await logger.warn('实例返回 4xx 错误，停止重试', { status: response.status, instanceId: instance.id }, ctx);
        if (last5xxResponse && last5xxResponse.body) {
          await last5xxResponse.body.cancel().catch(() => {});
        }
        return response;
      }
      
      // 5xx 错误：保存并继续尝试其他实例
      if (response.status >= 500) {
        if (last5xxResponse && last5xxResponse.body) {
          await last5xxResponse.body.cancel().catch(() => {});
        }
        last5xxResponse = response;
        continue;
      }
      
      // 2xx, 3xx 响应：成功，取消之前保存的 5xx 响应
      if (last5xxResponse && last5xxResponse.body) {
        await last5xxResponse.body.cancel().catch(() => {});
      }
      return response;
    } catch (error) {
      await logger.error('转发请求失败', { instanceId: instance.id, error: error.message }, ctx);
      lastError = error;
    }
  }

  // 如果有 5xx 响应，返回最后一个 5xx 响应（new-features 测试期望）
  if (last5xxResponse) {
    await logger.warn('所有实例均返回 5xx', { status: last5xxResponse.status }, ctx);
    return last5xxResponse;
  }

  // 如果没有 5xx 响应但有错误，抛出错误
  if (lastError) {
    throw lastError;
  }

  // 如果既没有 5xx 响应也没有错误，说明所有实例都失败了
  throw new Error('All instances failed');
}

/**
 * 故障转移相关函数
 */
function shouldFailover(error, env) {
  // 检查是否有可用的故障转移提供者
  const hasUpstash = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN;
  const hasNFRedis = env.NF_REDIS_URL && env.NF_REDIS_TOKEN;
  
  if (!hasUpstash && !hasNFRedis) {
    return false;
  }

  // 如果当前已经是故障转移模式，不再故障转移
  if (currentProvider === 'upstash' || currentProvider === 'nf-redis') {
    return false;
  }

  const errorMessage = error.message.toLowerCase();
  
  // 配额错误或网络错误立即故障转移
  if (errorMessage.includes('free usage limit') ||
      errorMessage.includes('quota exceeded') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('fetch failed') ||
      errorMessage.includes('network')) {
    return true;
  }

  // 其他错误需要连续失败3次
  const now = Date.now();
  if (now - lastFailureTime > 60000) { // 1分钟窗口
    failureCount = 0;
  }
  
  failureCount++;
  lastFailureTime = now;

  if (failureCount >= 3) {
    failoverReason = `连续失败${failureCount}次`;
    return true;
  }

  return false;
}

function failover(env) {
  const hasUpstash = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN;
  const hasNFRedis = env.NF_REDIS_URL && env.NF_REDIS_TOKEN;
  
  // 优先级：Upstash > NF Redis
  if (hasUpstash) {
    currentProvider = 'upstash';
    logger.info('故障转移到 Upstash Redis', { reason: failoverReason });
    return true;
  } else if (hasNFRedis) {
    currentProvider = 'nf-redis';
    logger.info('故障转移到 NF Redis', { reason: failoverReason });
    return true;
  }
  
  return false;
}

function getCurrentProvider() {
  if (currentProvider === 'upstash') {
    return 'Upstash Redis';
  } else if (currentProvider === 'nf-redis') {
    return 'NF Redis';
  }
  return 'Cloudflare KV';
}

function isRetryableError(error) {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('free usage limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('rate limit') ||
    msg.includes('network timeout') ||
    msg.includes('fetch failed')
  );
}

/**
 * 执行 NF Redis 操作
 */
async function executeNFRedis(operation, env, key, value = null) {
  const baseUrl = env.NF_REDIS_URL;
  const token = env.NF_REDIS_TOKEN;
  
  if (!baseUrl || !token) {
    throw new Error('NF Redis not configured');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  if (operation === '_nf_redis_get') {
    // GET 请求不需要 Content-Type
    const getHeaders = { 'Authorization': `Bearer ${token}` };
    const response = await fetch(`${baseUrl}/get/${key}`, { headers: getHeaders });
    
    if (response.status === 404) {
      await response.body.cancel();
      return null;
    }
    
    if (!response.ok) {
      throw new Error(`NF Redis Get Error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.result;
  } else if (operation === '_nf_redis_put') {
    const response = await fetch(`${baseUrl}/set/${key}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value })
    });
    
    if (!response.ok) {
      throw new Error(`NF Redis Put Error: ${response.status} ${response.statusText}`);
    }
    
    return true;
  }
}

/**
 * 执行操作并支持故障转移
 */
async function executeWithFailover(operation, env, ctx, ...args) {
  const operations = {
    '_kv_get': async () => {
      if (env.KV_STORAGE) {
        return await env.KV_STORAGE.get(args[0]);
      }
      throw new Error('KV_STORAGE not available');
    },
    '_kv_put': async () => {
      if (env.KV_STORAGE) {
        return await env.KV_STORAGE.put(args[0], args[1]);
      }
      throw new Error('KV_STORAGE not available');
    },
    '_kv_list': async () => {
      if (env.KV_STORAGE) {
        return await env.KV_STORAGE.list({ prefix: args[0] });
      }
      throw new Error('KV_STORAGE not available');
    },
    '_upstash_get': async () => {
      const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${args[0]}`, {
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
    },
    '_upstash_put': async () => {
      const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${args[0]}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ value: args[1] })
      });

      if (!response.ok) {
        throw new Error(`Upstash Put Error: ${response.status} ${response.statusText}`);
      }

      return true;
    },
    '_nf_redis_get': async () => {
      return await executeNFRedis('_nf_redis_get', env, args[0]);
    },
    '_nf_redis_put': async () => {
      return await executeNFRedis('_nf_redis_put', env, args[0], args[1]);
    }
  };

  const operationMap = {
    '_kv_get': ['_upstash_get', '_nf_redis_get'],
    '_kv_put': ['_upstash_put', '_nf_redis_put'],
    '_kv_list': null // 不支持 list 的故障转移
  };

  // 第一次尝试
  try {
    return await operations[operation]();
  } catch (error) {
    await logger.error('Primary operation failed', { operation, error: error.message }, ctx);

    // 检查是否应该故障转移
    if (shouldFailover(error, env) && operationMap[operation]) {
      failover(env);
      
      // 尝试故障转移（按优先级：Upstash -> NF Redis）
      const failoverOps = operationMap[operation];
      for (const failoverOp of failoverOps) {
        try {
          await logger.info('尝试故障转移', { from: operation, to: failoverOp }, ctx);
          return await operations[failoverOp]();
        } catch (failoverError) {
          await logger.warn('故障转移失败', { operation: failoverOp, error: failoverError.message }, ctx);
          continue; // 继续尝试下一个
        }
      }
      
      // 所有故障转移都失败
      throw new Error('All failover operations failed');
    }

    throw error;
  }
}

/**
 * Upstash Redis GET（用于故障转移）
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
 * 导出函数（供测试使用）
 */
export {
  verifyQStashSignature,
  parseInstanceData,
  getActiveInstances,
  selectTargetInstance,
  forwardToInstance,
  fetchWithRetry,
  shouldFailover,
  failover,
  getCurrentProvider,
  isRetryableError,
  executeWithFailover,
  logger,
  upstash_get,
  detectCacheProvider,
  normalizePath,
  executeNFRedis,
  scanLockKeys,
  handleRequest
};

// 状态访问器（供测试使用）
const getCurrentProviderState = () => ({ currentProvider, failureCount, lastFailureTime, failoverReason });
const setCurrentProviderState = (state) => {
  if (state.currentProvider !== undefined) currentProvider = state.currentProvider;
  if (state.failureCount !== undefined) failureCount = state.failureCount;
  if (state.lastFailureTime !== undefined) lastFailureTime = state.lastFailureTime;
  if (state.failoverReason !== undefined) failoverReason = state.failoverReason;
};

export { getCurrentProviderState, setCurrentProviderState };

/**
 * Worker 处理器
 */
const handler = {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};

/**
 * 修复 @microlabs/otel-cf-workers 库的 Bug
 * 该库在拦截环境变量访问时，如果值为 undefined 会导致 isKVNamespace 函数报错
 * TypeError: Cannot read properties of undefined (reading 'getWithMetadata')
 */
const createSafeEnv = (env) => {
  return new Proxy(env || {}, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // 如果值为 undefined，返回空字符串
      // 这样 isKVNamespace checks (value.getWithMetadata) 会变成 undefined (safe)
      // 且空字符串是 falsy 值，不影响一般的 if (env.VAR) 判断
      if (value === undefined) {
        return "";
      }
      return value;
    }
  });
};

/**
 * Worker 主入口 - 使用 instrument 包装器
 */
export default {
  async fetch(request, env, ctx) {
    // 创建安全的环境变量包装器，防止 OTel 库访问 undefined 属性时崩溃
    const safeEnv = createSafeEnv(env);
    
    // 如果配置了 Axiom，使用 instrument 包装器
    if (!isTestEnvironment && env.AXIOM_TOKEN && env.AXIOM_DATASET) {
      const config = {
        serviceName: 'lb-worker-js',
        exporter: {
          url: 'https://api.axiom.co/v1/traces',
          headers: {
            'Authorization': `Bearer ${env.AXIOM_TOKEN}`,
            'X-Axiom-Dataset': env.AXIOM_DATASET,
            'X-Axiom-Org-Id': env.AXIOM_ORG_ID || ''
          }
        }
      };
      return instrument(handler, config).fetch(request, safeEnv, ctx);
    }
    
    // 没有 Axiom 配置，直接处理
    return handler.fetch(request, safeEnv, ctx);
  }
};

/**
 * Flush pending logs to Axiom
 */
async function flushLogs(env, ctx = null) {
  if (!pendingLogs.length || !env.AXIOM_TOKEN || !env.AXIOM_DATASET) {
    pendingLogs = [];
    return;
  }

  const url = `https://api.axiom.co/v1/datasets/${env.AXIOM_DATASET}/ingest`;
  const headers = {
    'Authorization': `Bearer ${env.AXIOM_TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (env.AXIOM_ORG_ID) {
    headers['X-Axiom-Org-Id'] = env.AXIOM_ORG_ID;
  }

  // Chunk if > 50 logs
  const chunkSize = 50;
  for (let i = 0; i < pendingLogs.length; i += chunkSize) {
    const chunk = pendingLogs.slice(i, i + chunkSize);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk)
      });
      if (!res.ok) {
        const err = await res.text();
        await logger.warn('Axiom log ingest failed', { status: res.status, error: err, chunkIndex: i }, ctx);
      }
    } catch (e) {
      await logger.warn('Axiom log flush error', { error: e.message, chunkIndex: i }, ctx);
    }
  }
  pendingLogs = [];
}

/**
 * 路径映射 - 将契约路径映射到实际路径
 */
const PATH_MAP = {
  '/api/tasks/download-tasks': '/api/tasks/download',
  '/api/tasks/upload-tasks': '/api/tasks/upload',
  '/api/tasks/media-batch': '/api/tasks/media-batch'
};

/**
 * 规范化路径
 */
function normalizePath(pathname) {
  return PATH_MAP[pathname] || pathname;
}

/**
 * Worker 主逻辑
 */
async function handleRequest(request, env, ctx) {
  // Reset per-request logs
  pendingLogs = [];

  const normalizedUrl = new URL(request.url);
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');
  
  // 路径规范化：将契约路径映射到实际路径
  const originalPath = normalizedUrl.pathname;
  normalizedUrl.pathname = normalizePath(normalizedUrl.pathname);
  
  // 记录路径映射（如果发生映射）
  if (originalPath !== normalizedUrl.pathname) {
    await logger.info('路径规范化', {
      original: originalPath,
      normalized: normalizedUrl.pathname
    }, ctx);
  }

  // 环境变量检查
  if (!env.AXIOM_TOKEN) {
    console.warn('AXIOM_TOKEN 未设置，日志功能将被禁用');
  }
  if (!env.QSTASH_CURRENT_SIGNING_KEY && env.SKIP_SIGNATURE_VERIFY !== 'true') {
    console.warn('QSTASH_CURRENT_SIGNING_KEY 未设置，Webhook 请求将被拒绝');
  }

  // 初始化日志配置
  logger.configure({ env: env.NODE_ENV || 'production' });
  await logger.info('环境初始化', { nodeEnv: env.NODE_ENV || 'production', hasKv: !!env.KV_STORAGE }, ctx);

  // 健康检查
  if ((request.method === 'GET' || request.method === 'HEAD') && normalizedUrl.pathname === '/health') {
    return new Response('LB is running', { status: 200 });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  // 验证签名
  let body = null;
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      body = await verifyQStashSignature(request, env, true, ctx);
    } else {
      body = await verifyQStashSignature(request, env, false, ctx);
    }
    if (body === null) body = new Uint8Array();
  } catch (error) {
    // 获取 QStash 元数据
    const qstashMsgId = request.headers.get('Upstash-Message-Id');
    const retryCount = request.headers.get('Upstash-Retries');
    
    await logger.warn('签名验证失败', { 
      error: error.message, 
      url: request.url,
      qstashMsgId,
      retryCount
    }, ctx);
    
    return new Response(JSON.stringify({
      error: 'Signature verification failed',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  // 获取活跃实例
  const activeInstances = await getActiveInstances(env, ctx);
  await logger.info('活跃实例查询完成', { count: activeInstances.length }, ctx);

  if (activeInstances.length === 0) {
    const qstashMsgId = request.headers.get('Upstash-Message-Id');
    const retryCount = request.headers.get('Upstash-Retries');
    
    await logger.warn('无活跃实例可用', {
      qstashMsgId,
      retryCount,
      path: normalizedUrl.pathname
    }, ctx);
    
    return new Response(JSON.stringify({
      error: 'No active instances available',
      qstashMsgId,
      timestamp: new Date().toISOString()
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60'
      }
    });
  }

  // 选择目标实例
  const targetInstance = await selectTargetInstance(activeInstances, env, ctx);
  if (!targetInstance) {
    return new Response('No target instance selected', { status: 503 });
  }

  await logger.info('开始转发请求', { instanceId: targetInstance.id, url: targetInstance.url }, ctx);

  // 转发请求
  const response = await fetchWithRetry([targetInstance, ...activeInstances.filter(i => i !== targetInstance)], normalizedUrl, request, env, body, ctx);

  await logger.debug('负载均衡请求完成', { status: response.status }, ctx);

  // Flush logs to Axiom (fire-and-forget, non-blocking)
  await flushLogs(env, ctx);

  return response;
}