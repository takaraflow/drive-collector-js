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

// 常量
const ROUND_ROBIN_KEY = 'lb:round_robin_index';
const HEARTBEAT_TIMEOUT = 15 * 60 * 1000; // 15分钟

// 模块缓存
let qstashModule = null;

// 静态导入 OpenTelemetry API
import { trace } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';

/**
 * 动态导入模块（用于测试兼容）
 */
async function importModules() {
  if (isTestEnvironment) {
    // 测试环境：使用 mock
    if (!qstashModule) {
      qstashModule = {
        Receiver: class {
          constructor(options) {
            this.currentSigningKey = options.currentSigningKey;
            this.nextSigningKey = options.nextSigningKey;
          }
          async verify(options) {
            // 检查是否有全局 mock 验证器
            if (global.__QSTASH_MOCK_VERIFY__) {
              return global.__QSTASH_MOCK_VERIFY__(options);
            }
            // 默认验证成功
            return true;
          }
        },
        SignatureError: class SignatureError extends Error {
          constructor(message) {
            super(message);
            this.name = 'SignatureError';
          }
        }
      };
    }
    return;
  }

  // 生产环境：导入真实模块
  if (!qstashModule) {
    try {
      // 强制使用 @upstash/qstash/cloudflare 导出的 serve 逻辑
      // 虽然它只导出 serve，但我们可以通过它来验证
      const { serve } = await import('@upstash/qstash/cloudflare');
      qstashModule = { serve };
    } catch (e) {
      console.warn('QStash Cloudflare not available:', e.message);
    }
  }
}

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
      span.addEvent(message, {
        ...meta,
        'log.level': 'info',
        'service.name': 'lb-worker-js'
      });
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
      span.addEvent(message, {
        ...meta,
        'log.level': 'warn',
        'service.name': 'lb-worker-js'
      });
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
      span.addEvent('error', {
        ...meta,
        'log.level': 'error',
        'error.message': error.message,
        'error.stack': error.stack,
        'service.name': 'lb-worker-js'
      });
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
 * 验证 QStash 签名
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

  if (!env.QSTASH_CURRENT_SIGNING_KEY) {
    throw new Error('QSTASH_CURRENT_SIGNING_KEY 未设置');
  }

  const signature = request.headers.get('Upstash-Signature');
  if (!signature) throw new Error('Missing Upstash-Signature header');

  const timestamp = request.headers.get('Upstash-Timestamp');
  if (timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const expWindow = parseInt(env.SIGNATURE_EXPIRATION_WINDOW || '900');
    if (now - parseInt(timestamp) > expWindow) throw new Error('Signature expired');
  }

  // 如果是 GET 请求，直接返回 null，不读取 body
  if (isGetRequest) {
    return null;
  }

  // 读取 body
  let body;
  if (request.arrayBuffer) {
    const buffer = await request.arrayBuffer();
    body = new Uint8Array(buffer);
  } else {
    const text = await request.text();
    body = new TextEncoder().encode(text);
  }

  // 在测试环境中使用 mock 验证
  if (global.__QSTASH_MOCK_VERIFY__) {
    try {
      // 测试期望 body 是 Uint8Array，所以传递 Uint8Array
      const isValid = await global.__QSTASH_MOCK_VERIFY__({
        signature,
        body: body,
        url: request.url,
        clockTolerance: 300
      });
      if (!isValid) throw new Error('Signature verification failed');
      // 返回 Uint8Array 以匹配测试期望
      return body;
    } catch (e) {
      await logger.error('QStash mock 验证失败', { error: e.message }, ctx);
      throw e;
    }
  }

  // 尝试从 @upstash/qstash 导入
  try {
    const { Receiver } = await import('@upstash/qstash');
    const receiver = new Receiver({
      currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY || env.QSTASH_CURRENT_SIGNING_KEY,
    });
    const bodyString = new TextDecoder().decode(body);
    const isValid = await receiver.verify({
      signature,
      body: bodyString,
      url: request.url,
      clockTolerance: 300
    });
    if (!isValid) throw new Error('Signature verification failed');
    // 返回 Uint8Array 以匹配测试期望
    return body instanceof Uint8Array ? body : new Uint8Array(body);
  } catch (e) {
    // 如果是签名验证失败，直接抛出
    if (e.message === 'Signature verification failed') {
      throw e;
    }
    // 如果导入失败，提供更友好的错误信息
    if (e.message.includes('Cannot find module') || e.message.includes('Invalid Compact JWS')) {
      await logger.error('QStash 模块加载失败，请检查依赖安装', { error: e.message }, ctx);
      throw new Error('QStash 模块不可用，请检查 @upstash/qstash 是否正确安装');
    }
    // 其他错误
    await logger.error('QStash 验证失败', { error: e.message }, ctx);
    throw e;
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
 * 获取活跃实例
 */
async function getActiveInstances(env, ctx = null) {
  try {
    const result = await executeWithFailover('_kv_list', env, ctx, 'instance:');
    
    if (!result || !result.keys) {
      return [];
    }

    const instances = [];
    const now = Date.now();

    for (const key of result.keys) {
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

    await logger.debug('获取活跃实例', { count: instances.length }, ctx);
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
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return false;
  }

  // 如果当前已经是 Upstash 模式，不再故障转移
  if (currentProvider === 'upstash') {
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
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return false;
  }

  currentProvider = 'upstash';
  logger.info('故障转移到 Upstash Redis', { reason: failoverReason });
  return true;
}

function getCurrentProvider() {
  if (currentProvider === 'upstash') {
    return 'Upstash Redis';
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
    }
  };

  const operationMap = {
    '_kv_get': '_upstash_get',
    '_kv_put': '_upstash_put',
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
      
      // 尝试故障转移
      try {
        return await operations[operationMap[operation]]();
      } catch (failoverError) {
        await logger.error('Failover operation also failed', { operation: operationMap[operation], error: failoverError.message }, ctx);
        throw failoverError;
      }
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
  upstash_get
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
    await importModules();
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
            'X-Axiom-Dataset': env.AXIOM_DATASET
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
 * Worker 主逻辑
 */
async function handleRequest(request, env, ctx) {
  const normalizedUrl = new URL(request.url);
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

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

  return response;
}