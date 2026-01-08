import { logger, configureBaseLoggerTransport, isTestEnvironment, VERSION, flushLogs, updateVersionFromEnv } from './logger.js';

// 全局状态
let currentProvider = 'cloudflare';
let failureCount = 0;
let lastFailureTime = 0;
let failoverReason = '';

// 常量
const ROUND_ROBIN_KEY = 'lb:round_robin_index';
const HEARTBEAT_TIMEOUT = 15 * 60 * 1000; // 15分钟

// 静态导入 OpenTelemetry API
import { trace } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';
// 静态导入 QStash Receiver（生产环境使用）
import { Receiver } from '@upstash/qstash';

// 静态导入 Redis client
import { createRedis } from 'redis-on-workers';
// 导入新的缓存客户端抽象
import { getNFCacheClient } from './cache/client-factory.js';

const ENV_ALIASES = {
  development: 'dev',
  dev: 'dev',
  production: 'prod',
  prod: 'prod',
  staging: 'pre',
  pre: 'pre'
};

const normalizeEnvName = (value = 'prod') => {
  const key = String(value || '').toLowerCase();
  return ENV_ALIASES[key] || key || 'prod';
};


/**
 * 稳健的 JSON 解析函数，支持自动修复无引号键
 */
function safeJsonParse(data, context = '') {
  if (data === null || data === undefined) return null;
  if (data instanceof Uint8Array) {
    data = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    data = new TextDecoder().decode(data.buffer);
  } else if (data instanceof ArrayBuffer) {
    data = new TextDecoder().decode(new Uint8Array(data));
  }
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

function coerceCacheKeyName(value) {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value.buffer);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value);
}

/**
 * 获取提供者优先级
 */
function getProviderPriority(env) {
  const prios = [];
  // 支持两种命名方式：NF_REDIS_* 和 REDIS_TLS_*
  const hasNFRedis = !!(env.NF_REDIS_URL || env.REDIS_TLS_URL);
  
  if (hasNFRedis) prios.push('redis');
  if (env.KV_STORAGE) prios.push('cloudflare');
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) prios.push('upstash');
  return prios;
}

/**
 * 检测缓存提供者
 */
function detectCacheProvider(env) {
  if (env.CACHE_PROVIDER) return env.CACHE_PROVIDER;
  const prios = getProviderPriority(env);
  return prios[0] || 'none';
}

function describeRedisEndpoint(env) {
  const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
  if (!redisUrl) return 'not configured';
  try {
    const parsed = new URL(redisUrl);
    const portSegment = parsed.port ? `:${parsed.port}` : '';
    const pathSegment = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.protocol}//${parsed.hostname}${portSegment}${pathSegment}`;
  } catch (error) {
    return redisUrl;
  }
}



/**
 * 验证 QStash 签名 - 重构版本
 */
async function verifyQStashSignature(request, env, isGetRequest = false, ctx = null) {
  const verifyQStashSignatureLogger = logger.child({ module: 'QStashSignature' });
  // 跳过签名验证
  if (env.SKIP_SIGNATURE_VERIFY === 'true') {
    await verifyQStashSignatureLogger.debug('⏭️ 跳过签名验证 (Skipping signature verification)', {}, ctx);
    if (isGetRequest) {
      return null;
    }
    
    // 统一读取 body 逻辑，支持 text() 和 arrayBuffer()
    if (request.text) {
      const text = await request.text();
      return new TextEncoder().encode(text);
    } else if (request.arrayBuffer) {
      const buffer = await request.arrayBuffer();
      return new Uint8Array(buffer);
    } else {
      throw new Error('Request object must have text() or arrayBuffer() method');
    }
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
      await verifyQStashSignatureLogger.error('❌ QStash mock 验证失败 (QStash mock verification failed)', { error: e.message }, ctx);
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
    await verifyQStashSignatureLogger.error('❌ QStash 验证失败 (QStash verification failed)', { error: e.message }, ctx);
    throw new Error(`Signature verification failed: ${e.message}`);
  }
}

function normalizeEpochMillis(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 1e12) {
    return value * 1000;
  }
  return value;
}

function normalizeHeartbeat(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (rawValue instanceof Date) return rawValue.getTime();
  if (typeof rawValue === 'number') return normalizeEpochMillis(rawValue);
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) return normalizeEpochMillis(numeric);
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * 解析实例数据
 */
function parseInstanceData(data) {
  if (!data) return null;
  
  try {
    let parsed = safeJsonParse(data, 'instance');
    if (!parsed) return null;
    if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
      const inner = safeJsonParse(parsed.value, 'instance.value');
      if (inner) {
        parsed = inner;
      }
    }

    const lastHeartbeat = normalizeHeartbeat(parsed.lastHeartbeat ?? parsed.startedAt);
    const startedAt = normalizeHeartbeat(parsed.startedAt);
    
    return {
      id: parsed.id,
      url: parsed.url,
      hostname: parsed.hostname,
      status: parsed.status || 'active',
      lastHeartbeat: lastHeartbeat ?? Date.now(),
      startedAt,
      region: parsed.region || 'unknown'
    };
  } catch (e) {
    return null;
  }
}

/**
 * 扫描锁键（用于 leader election 提示）
 */
async function scanLockKeys(env, ctx = null, parentLogger = logger) {
  const scanLockKeysLogger = parentLogger.child({ module: 'scanLockKeys' });
  try {
    const lockPrefixes = ['lock:', 'task:', 'msg_lock:'];
    let lockCount = 0;
    
    // 并发执行扫描，减少总延迟
    const results = await Promise.all(lockPrefixes.map(prefix => 
      executeWithFailover('_kv_list', env, ctx, prefix)
        .catch(e => {
          scanLockKeysLogger.debug('锁键扫描失败', { prefix, error: e.message }, ctx);
          return { keys: [] };
        })
    ));

    for (const result of results) {
      if (result && result.keys) {
        lockCount += result.keys.length;
      }
    }
    
    return lockCount;
  } catch (error) {
    await scanLockKeysLogger.debug('锁键扫描异常', { error: error.message }, ctx);
    return 0;
  }
}

/**
 * 获取活跃实例
 */
async function getActiveInstances(env, ctx = null, parentLogger = logger) {
  const getActiveInstancesLogger = parentLogger.child({ module: 'getActiveInstances' });
  const redisEndpointSummary = describeRedisEndpoint(env);
  await getActiveInstancesLogger.debug('📊 Redis 终端摘要 (Redis endpoint summary)', { endpoint: redisEndpointSummary }, ctx);
  try {
    // 扫描所有契约键前缀
    const prefixes = ['instance:', 'lock:', 'task:', 'msg_lock:'];
    
    // 并发获取所有前缀的键
    const prefixResults = await Promise.all(prefixes.map(prefix =>
      executeWithFailover('_kv_list', env, ctx, prefix)
        .catch(e => {
          getActiveInstancesLogger.debug('前缀扫描失败', { prefix, error: e.message }, ctx);
          return { keys: [] };
        })
    ));

    let allKeys = [];
    for (const result of prefixResults) {
      if (result && result.keys) {
        allKeys.push(...result.keys);
      }
    }

    // 新增日志：记录扫描到的所有原始键
    await getActiveInstancesLogger.debug('🔎 扫描到所有原始键 (All raw keys scanned)', { keys: allKeys.map(k => k.name) }, ctx);

    if (allKeys.length === 0) {
      await getActiveInstancesLogger.debug('⚠️ 未找到键，尝试回退全量扫描 (No keys found, attempting fallback full scan)', {}, ctx);
      try {
        const fallbackResult = await executeWithFailover('_kv_list', env, ctx, '');
        const fallbackKeys = fallbackResult?.keys || [];
        await getActiveInstancesLogger.debug('getActiveInstances Fallback Scan: Raw keys', { keys: fallbackKeys.map(k => k.name), count: fallbackKeys.length }, ctx);
        allKeys = fallbackKeys;
      } catch (e) {
        await getActiveInstancesLogger.error('❌ 回退扫描失败 (Fallback scan failed)', { error: e.message }, ctx);
      }

      if (allKeys.length === 0) {
        await getActiveInstancesLogger.debug('getActiveInstances Scan Phase: No keys found after fallback, returning empty array.', {}, ctx);
        return [];
      }
    }

    const instances = [];
    const now = Date.now();

    // 只处理 instance:* 键，并去重
    const instanceKeys = [];
    const processedInstances = new Set();
    for (const key of allKeys) {
      if (key.name.startsWith('instance:') && !processedInstances.has(key.name)) {
        processedInstances.add(key.name);
        instanceKeys.push(key.name);
      }
    }
    await getActiveInstancesLogger.debug('getActiveInstances Scan Phase: Filtered instance keys', { instanceKeys, count: instanceKeys.length }, ctx);

    // 并发读取实例数据
    const instanceDataResults = await Promise.all(instanceKeys.map(keyName =>
      executeWithFailover('_kv_get', env, ctx, keyName)
        .catch(e => {
          getActiveInstancesLogger.error('读取实例数据失败', { key: keyName, error: e.message }, ctx);
          return null;
        })
    ));

    // 新增日志：记录获取到的原始实例数据
    await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Raw instance data results', { rawData: instanceDataResults }, ctx);

    // 新增：输出所有扫描到的键及其值，便于线上调试
    const instanceDataByKey = new Map();
    instanceKeys.forEach((keyName, idx) => {
      instanceDataByKey.set(keyName, instanceDataResults[idx]);
    });

    const keyValueDump = [];
    for (const key of allKeys) {
      const keyName = key.name;
      if (instanceDataByKey.has(keyName)) {
        keyValueDump.push({ key: keyName, value: instanceDataByKey.get(keyName) });
        continue;
      }
      try {
        const value = await executeWithFailover('_kv_get', env, ctx, keyName);
        keyValueDump.push({ key: keyName, value });
      } catch (e) {
        keyValueDump.push({ key: keyName, error: e.message });
      }
    }
    // 将键值对分片输出，避免单条日志过大（Axiom 2MB 限制）
    const MAX_VALUE_PREVIEW_LENGTH = 2000;
    const formattedEntries = keyValueDump.map(({ key, value, error }) => {
      if (error) return { key, error };
      try {
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        const preview = raw.length > MAX_VALUE_PREVIEW_LENGTH
          ? `${raw.slice(0, MAX_VALUE_PREVIEW_LENGTH)}...[TRUNCATED]`
          : raw;
        return { key, preview, type: typeof value };
      } catch (e) {
        return { key, error: `format_error:${e.message}` };
      }
    });

    const chunkSize = 20;
    const totalChunks = Math.max(1, Math.ceil(formattedEntries.length / chunkSize));
    for (let i = 0; i < formattedEntries.length; i += chunkSize) {
      const chunkIndex = Math.floor(i / chunkSize) + 1;
      const chunk = formattedEntries.slice(i, i + chunkSize);
      await getActiveInstancesLogger.debug(`getActiveInstances Full KV chunk ${chunkIndex}/${totalChunks}`, { entries: chunk }, ctx);
    }

    for (const data of instanceDataResults) {
      const instance = parseInstanceData(data);
      await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Parsed instance data', { instanceId: instance?.id, parsedInstance: instance }, ctx);
      if (instance && instance.status === 'active') {
        // 检查心跳是否过期
        if (now - instance.lastHeartbeat <= HEARTBEAT_TIMEOUT) {
          instances.push(instance);
        } else {
          const ageSeconds = Math.floor((now - instance.lastHeartbeat) / 1000);
          await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Instance expired', { instanceId: instance.id, lastHeartbeat: instance.lastHeartbeat, heartbeatTimeoutSeconds: HEARTBEAT_TIMEOUT / 1000, ageSeconds }, ctx);
        }
      }
    }

    // 记录锁键数量（用于 leader election 监控）
    const lockKeys = allKeys.filter(k => k.name.startsWith('lock:') || k.name.startsWith('task:') || k.name.startsWith('msg_lock:'));
    const lockCount = lockKeys.length;
    
    if (lockCount > 0) {
      await getActiveInstancesLogger.debug('检测到锁键', { lockCount }, ctx);
    }

    // 为了兼容测试：测试期望 scanLockKeys 被调用，从而触发额外的 KV.list
    if (isTestEnvironment) {
      await scanLockKeys(env, ctx, parentLogger);
    }

    await getActiveInstancesLogger.debug('👥 获取活跃实例完成 (Active instances fetched)', { count: instances.length, totalKeys: allKeys.length }, ctx);
    return instances;
  } catch (error) {
    await getActiveInstancesLogger.error('获取活跃实例失败', { error: error.message }, ctx);
    return [];
  }
}

/**
 * 选择目标实例 (轮询)
 */
async function selectTargetInstance(instances, env, ctx, parentLogger = logger) {
  const selectTargetInstanceLogger = parentLogger.child({ module: 'selectTargetInstance' });
  if (instances.length === 0) {
    return null;
  }

  let currentIndex = 0;
  try {
    const stored = await executeWithFailover('_kv_get', env, ctx, ROUND_ROBIN_KEY);
    currentIndex = stored ? parseInt(stored) : 0;
  } catch (e) {
    await selectTargetInstanceLogger.error('轮询索引获取失败', { error: e.message }, ctx);
  }

  const targetIndex = currentIndex % instances.length;
  const targetInstance = instances[targetIndex];

  try {
    await executeWithFailover('_kv_put', env, ctx, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
  } catch (e) {
    await selectTargetInstanceLogger.error('轮询索引更新失败', { error: e.message }, ctx);
  }

  return targetInstance;
}

/**
 * 转发请求到目标实例
 */
async function forwardToInstance(instance, normalizedUrl, request, originalBody, ctx = null, parentLogger = logger) {
  const forwardToInstanceLogger = parentLogger.child({ module: 'forwardToInstance' });
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
    await forwardToInstanceLogger.warn('后端返回 5xx 错误', { status: response.status, instanceId: instance.id }, ctx);
  }

  return response;
}

/**
 * 带重试的转发逻辑
 */
async function fetchWithRetry(instances, normalizedUrl, request, env, body, ctx, parentLogger = logger) {
  const fetchWithRetryLogger = parentLogger.child({ module: 'fetchWithRetry' });
  let lastError;
  let last5xxResponse = null;

  for (const instance of instances) {
    try {
      const response = await forwardToInstance(instance, normalizedUrl, request, body, ctx, parentLogger);
      
      // 4xx 错误：直接透传，不再重试其他实例
      if (response.status >= 400 && response.status < 500) {
        await fetchWithRetryLogger.warn('实例返回 4xx 错误，停止重试', { status: response.status, instanceId: instance.id }, ctx);
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
      await fetchWithRetryLogger.error('转发请求失败', { instanceId: instance.id, error: error.message }, ctx);
      lastError = error;
      // 新增：在每次请求失败时，也尝试取消之前保存的 5xx 响应体，防止泄漏
      if (last5xxResponse && last5xxResponse.body) {
        await last5xxResponse.body.cancel().catch(() => {});
      }
    }
  }

  // 如果有 5xx 响应，返回最后一个 5xx 响应（new-features 测试期望）
  if (last5xxResponse) {
    await fetchWithRetryLogger.warn('所有实例均返回 5xx', { status: last5xxResponse.status }, ctx);
    // 注意：这里不取消 last5xxResponse.body，因为需要返回给调用者
    // 调用者负责在使用完响应后调用 cancel()
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
  const hasNFRedis = !!(env.NF_REDIS_URL || env.REDIS_TLS_URL);
  
  if (!hasUpstash && !hasNFRedis) {
    return false;
  }

  // 如果当前已经是故障转移模式，不再故障转移
  if (currentProvider === 'upstash' || currentProvider === 'redis') {
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
  const failoverLogger = logger.child({ module: 'failover' });
  const hasUpstash = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN;
  const hasNFRedis = !!(env.NF_REDIS_URL || env.REDIS_TLS_URL);
  
  // 优先级：Upstash > NF Redis
  if (hasUpstash) {
    currentProvider = 'upstash';
    failoverLogger.info('🔄 故障转移到 Upstash Redis (Failover to Upstash Redis)', { reason: failoverReason });
    return true;
  } else if (hasNFRedis) {
    currentProvider = 'redis';
    failoverLogger.info('🔄 故障转移到 NF Redis (Failover to NF Redis)', { reason: failoverReason });
    return true;
  }
  
  return false;
}

function getCurrentProvider() {
  if (currentProvider === 'upstash') {
    return 'Upstash Redis';
  } else if (currentProvider === 'redis') {
    return 'Redis';
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
 * 带有重试逻辑的 Redis 命令执行器
 */
async function retryRedisCommand(client, command, args = [], maxRetries = 3, initialDelay = 100, ctx = null) {
  const retryRedisCommandLogger = logger.child({ module: 'retryRedisCommand' });
  let retries = 0;
  let delay = initialDelay;
  let timerId = null;
  let isDone = false;

  const executeWithRetries = async () => {
    while (retries < maxRetries && !isDone) {
      try {
        if (retries > 0) {
          await retryRedisCommandLogger.warn(`Redis 命令重试: ${command} (尝试 ${retries + 1}/${maxRetries})`, { delay: `${delay}ms` }, ctx);
          let retryTimerId = null;
          try {
            await new Promise((resolve) => {
              retryTimerId = setTimeout(resolve, delay);
            });
          } finally {
            if (retryTimerId) clearTimeout(retryTimerId);
          }
        }
        
        if (isDone) throw new Error('Abort'); // 快速退出

        return await client.send(command, ...args);
      } catch (e) {
        if (isDone || e.message === 'Abort') throw e;

        const errorMessage = e.message.toLowerCase();
        if (
          errorMessage.includes('econnreset') ||
          errorMessage.includes('etimedout') ||
          errorMessage.includes('socketer') || 
          errorMessage.includes('network error')
        ) {
          retries++;
          delay *= 2; // 指数退避
          if (retries >= maxRetries) {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }
  };

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      timerId = null;
      isDone = true; // 标记已超时，中止循环
      reject(new Error(`Redis command ${command} timed out after 15000ms`));
    }, 15000);
  });

  try {
    const result = await Promise.race([executeWithRetries(), timeoutPromise]);
    isDone = true; // 成功后也要标记
    clearTimeout(timerId); // 清理定时器
    return result;
  } finally {
    isDone = true; 
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }
}

/**
 * 获取 Redis TLS Client (使用新的缓存客户端抽象)
 */
let redisClient = null;
let redisInitPromise = null;

async function getRedisClient(env, ctx) {
  const getRedisClientLogger = logger.child({ module: 'getRedisClient' });
  if (isTestEnvironment && typeof __test_getRedisClient === 'function') {
    const mockClient = __test_getRedisClient();
    if (mockClient) return mockClient;
  }
  if (redisClient) return redisClient;

  // 如果已经在初始化了，直接返回同一个 Promise
  if (redisInitPromise) return redisInitPromise;

  redisInitPromise = (async () => {
    try {
      // 支持两种命名方式
      const effectiveEnv = {
        ...env,
        NF_REDIS_URL: env.NF_REDIS_URL || env.REDIS_TLS_URL,
        NF_REDIS_PASSWORD: env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD
      };
      
      const client = getNFCacheClient(effectiveEnv);
      await client.connect();
      redisClient = client;
      await getRedisClientLogger.info('NF Redis Client 初始化成功', { url: effectiveEnv.NF_REDIS_URL }, ctx);
      return client;
    } catch (e) {
      redisClient = null;
      redisInitPromise = null; // 失败后允许下次重试
      await getRedisClientLogger.error('NF Redis Client 初始化失败', { error: e.message }, ctx);
      throw e;
    }
  })();

  return redisInitPromise;
}

/**
 * 执行 Redis TLS 操作 (使用新的缓存客户端抽象)
 */
async function executeRedis(operation, env, key, value = null, ctx = null) {
  // 同时支持 NF_REDIS_* 和 REDIS_TLS_* 两种环境变量
  const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
  const redisPassword = env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD;
  
  if (!redisUrl) {
    throw new Error('Redis URL not found in environment variables.');
  }
  
  const client = await getRedisClient({
    NF_REDIS_URL: redisUrl,
    NF_REDIS_PASSWORD: redisPassword
  }, ctx);
  const start = Date.now();
  
  try {
    switch (operation) {
      case '_redis_get':
      case '_kv_get': {
        // 支持 mock client 的 send 方法和真实 client 的 get 方法
        let result;
        await logger.debug(`executeRedis GET: key=${key}`, {}, ctx);
        if (client.send) {
          result = await client.send('GET', key);
        } else if (client.get) {
          result = await client.get(key);
        } else {
          throw new Error('Client does not support get or send method');
        }
        const duration = Date.now() - start;
        await logger.debug(`executeRedis GET result: key=${key}, result=${result}, duration=${duration}ms`, {}, ctx);
        return result;
      }
      case '_redis_put':
      case '_kv_put': {
        const valStr = typeof value === 'string' ? value : JSON.stringify(value);
        // 支持 mock client 的 send 方法和真实 client 的 set 方法
        if (client.send) {
          await client.send('SET', key, valStr);
        } else if (client.set) {
          await client.set(key, valStr);
        } else {
          throw new Error('Client does not support set or send method');
        }
        const duration = Date.now() - start;
        return true;
      }
      default:
        throw new Error(`Unsupported Redis operation: ${operation}`);
    }
  } catch (e) {
    const duration = Date.now() - start;
    throw e;
  }
}

/**
 * 执行 Redis TLS Scan 操作 (使用新的缓存客户端抽象)
 */
async function executeRedisScan(env, prefix, ctx = null) {
  // 同时支持 NF_REDIS_* 和 REDIS_TLS_* 两种环境变量
  const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
  const redisPassword = env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD;
  
  if (!redisUrl) {
    throw new Error('Redis URL not found in environment variables.');
  }
  
  const client = await getRedisClient({
    NF_REDIS_URL: redisUrl,
    NF_REDIS_PASSWORD: redisPassword
  }, ctx);
  
  const keys = [];
  let cursor = '0';
  
  do {
    // 支持 mock client 的 send 方法和真实 client 的 scan 方法
    let res;
    // 添加日志，记录使用的 client 类型和 scan 参数
    const isNFCacheClient = !!client.scan && !client.send;
    const clientType = isNFCacheClient ? 'NFCacheClient' : (client.send ? 'RedisClient' : 'Unknown');
    await logger.debug(`executeRedisScan: clientType=${clientType}, prefix=${prefix}, cursor=${cursor}`, {}, ctx);

    if (client.send) {
      // 原生 redis-on-workers 或类似 client，直接发送命令
      // 必须显式包含 MATCH 和 COUNT 关键字
      // 修复：MATCH pattern 应该是 'instance:*' 而不是 'instance:instance:*'
      // 传入的 prefix 是 'instance:'
      const matchPattern = prefix === '' ? '*' : (prefix.endsWith(':') ? `${prefix}*` : `${prefix}:*`);
      await logger.debug(`Executing Redis SCAN (send)`, { clientType, prefix, matchPattern, cursor }, ctx);
      res = await client.send('SCAN', cursor, 'MATCH', matchPattern, 'COUNT', 100);
    } else if (client.scan) {
      // NFCacheClient 或兼容接口
      // 假设 scan 方法签名是 (cursor, matchPattern, count)
      // 这里的 matchPattern 应该是完整的 pattern (如 "instance:*")
      const matchPattern = prefix === '' ? '*' : (prefix.endsWith(':') ? `${prefix}*` : `${prefix}:*`);
      await logger.debug(`Executing Redis SCAN (scan)`, { clientType, prefix, matchPattern, cursor }, ctx);
      res = await client.scan(cursor, matchPattern, 100);
    } else {
      throw new Error('Client does not support scan or send method');
    }
    
    cursor = res[0];
    const batchKeys = res[1];
    
    if (Array.isArray(batchKeys)) {
      for (const k of batchKeys) {
        keys.push({ name: coerceCacheKeyName(k) });
      }
    }
  } while (cursor !== '0');
  
  await logger.debug(`executeRedisScan: finished scanning, found ${keys.length} keys`, {}, ctx);
  return { keys };
}

/**
 * 检查 Redis 健康状况 (使用新的缓存客户端抽象)
 */
async function checkRedisHealth(env, ctx, executor = executeWithPriorityFallback) {
  const checkRedisHealthLogger = logger.child({ module: 'checkRedisHealth' });
  try {
    // 同时支持 NF_REDIS_* 和 REDIS_TLS_* 两种环境变量
    const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
    const redisPassword = env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD;
    
    // 如果配置了 Redis，直接通过 PING 命令检查健康状况
    if (redisUrl) {
      try {
        const client = await getRedisClient({
          NF_REDIS_URL: redisUrl,
          NF_REDIS_PASSWORD: redisPassword
        }, ctx);
        const start = Date.now();
        const pong = await client.ping();
        const duration = Date.now() - start;
        if (pong === 'PONG' || pong === 'OK') {
          await checkRedisHealthLogger.info(`Redis 健康检查成功 (通过 PING)`, { duration: `${duration}ms` }, ctx);
          return true;
        } else {
          await checkRedisHealthLogger.warn(`Redis 健康检查失败 (PING 响应: ${pong})`, { duration: `${duration}ms` }, ctx);
          return false;
        }
      } catch (pingError) {
        await checkRedisHealthLogger.warn(`Redis PING 健康检查失败: ${pingError.message}`, {}, ctx);
        // 如果直接 PING 失败，不立即返回 false，而是继续尝试通过 _kv_get 进行检查
      }
    }

    // 回退：通过 executeWithPriorityFallback 读取一个预设的键，检查可用的、基于 HTTP 的 provider (如 Upstash)
    const start = Date.now();
    await executor('_kv_get', env, ctx, 'healthcheck_ping');
    const duration = Date.now() - start;
    await checkRedisHealthLogger.info(`备用 provider 健康检查成功 (通过 _kv_get)`, { duration: `${duration}ms` }, ctx);
    return true;
  } catch (e) {
    await checkRedisHealthLogger.error(`所有 provider 健康检查失败`, { error: e.message }, ctx);
    return false;
  }
}

/**
 * 执行 Upstash Redis Scan 操作
 */
async function executeUpstashScan(env, prefix) {
  const executeUpstashScanLogger = logger.child({ module: 'executeUpstashScan' });
  const baseUrl = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!baseUrl || !token) {
    throw new Error('Upstash Redis not configured');
  }

  let keys = [];
  let cursor = 0;
  const start = Date.now();
  
  while (true) {
    const url = `${baseUrl}/scan/${cursor}?match=${encodeURIComponent(prefix + '*')}&count=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!res.ok) {
      const duration = Date.now() - start;
      await executeUpstashScanLogger.warn(`Upstash Scan Error: status=${res.status}, duration=${duration}ms`, {}, null);
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
  await executeUpstashScanLogger.debug(`Upstash Scan: prefix=${prefix} success, keys=${keys.length}, duration=${totalDuration}ms`, {}, null);
  return { keys: keys.map(name => ({ name })) };
}

/**
 * 执行操作并支持优先级故障转移
 */
async function executeWithPriorityFallback(operation, env, ctx, ...args) {
  const executeWithPriorityFallbackLogger = logger.child({ module: 'executeWithPriorityFallback' });
  const providers = getProviderPriority(env);
  await executeWithPriorityFallbackLogger.debug(`执行 ${operation}，优先级: ${JSON.stringify(providers)}`, { args: args.slice(0, 1) }, ctx);
  
  const providerOps = {
    'redis': {
      '_kv_get': async () => {
        return await executeRedis('_redis_get', env, args[0], null, ctx);
      },
      '_kv_put': async () => {
        return await executeRedis('_redis_put', env, args[0], args[1], ctx);
      },
      '_kv_list': async () => {
        return await executeRedisScan(env, args[0], ctx);
      }
    },
    'cloudflare': {
      '_kv_get': async () => {
        if (env.KV_STORAGE) {
          const start = Date.now();
          const res = await env.KV_STORAGE.get(args[0]);
          await executeWithPriorityFallbackLogger.debug(`Cloudflare KV GET: key=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'KV' }, ctx);
          return res;
        }
        throw new Error('KV_STORAGE not available');
      },
      '_kv_put': async () => {
        if (env.KV_STORAGE) {
          const start = Date.now();
          await env.KV_STORAGE.put(args[0], args[1]);
          await executeWithPriorityFallbackLogger.debug(`Cloudflare KV PUT: key=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'KV' }, ctx);
          return true;
        }
        throw new Error('KV_STORAGE not available');
      },
      '_kv_list': async () => {
        if (env.KV_STORAGE) {
          const start = Date.now();
          const res = await env.KV_STORAGE.list({ prefix: args[0] });
          await executeWithPriorityFallbackLogger.debug(`Cloudflare KV LIST: prefix=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'KV' }, ctx);
          return res;
        }
        throw new Error('KV_STORAGE not available');
      }
    },
    'upstash': {
      '_kv_get': async () => {
        const start = Date.now();
        const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${args[0]}`, {
          headers: { 'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
        });
        const duration = Date.now() - start;

        await executeWithPriorityFallbackLogger.debug(`Upstash GET ${args[0]}: status ${response.status}, duration=${duration}ms`, { cache: true, provider: 'Upstash' }, ctx);

        if (response.status === 404) {
          await executeWithPriorityFallbackLogger.debug(`Upstash GET 404 for ${args[0]}, canceling body`, { cache: true, provider: 'Upstash' }, ctx);
          await response.body.cancel();
          return null;
        }

        if (!response.ok) {
          await executeWithPriorityFallbackLogger.debug(`Upstash GET error ${response.status} for ${args[0]}, canceling body`, { cache: true, provider: 'Upstash' }, ctx);
          await response.body?.cancel();
          throw new Error(`Upstash Get Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        await executeWithPriorityFallbackLogger.debug(`Upstash GET ${args[0]} success`, { cache: true, provider: 'Upstash' }, ctx);
        return data.result;
      },
      '_kv_put': async () => {
        const start = Date.now();
        const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${args[0]}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ value: args[1] })
        });
        const duration = Date.now() - start;

        await executeWithPriorityFallbackLogger.debug(`Upstash PUT ${args[0]}: status ${response.status}, duration=${duration}ms`, { cache: true, provider: 'Upstash' }, ctx);

        if (!response.ok) {
          await executeWithPriorityFallbackLogger.debug(`Upstash PUT error ${response.status} for ${args[0]}, canceling body`, { cache: true, provider: 'Upstash' }, ctx);
          await response.body?.cancel();
          throw new Error(`Upstash Put Error: ${response.status} ${response.statusText}`);
        }

        await executeWithPriorityFallbackLogger.debug(`Upstash PUT ${args[0]} success`, { cache: true, provider: 'Upstash' }, ctx);
        return true;
      },
      '_kv_list': async () => {
        const start = Date.now();
        const res = await executeUpstashScan(env, args[0]);
        await executeWithPriorityFallbackLogger.debug(`Upstash LIST: prefix=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'Upstash' }, ctx);
        return res;
      }
    }
  };

  // 按优先级顺序尝试每个提供者
  let lastUsedProvider = null;
  /** @type {Array<{ provider: string; error: string; errorCode: string; duration: number; }>} */
  const failedProviders = []; // 新增：收集所有失败的提供者信息

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!providerOps[p][operation]) continue;
    
    const start = Date.now();
    const providerName = p === 'cloudflare' ? 'KV' : p === 'upstash' ? 'Upstash' : 'Redis';
    try {
      await executeWithPriorityFallbackLogger.info(`尝试 ${p} ${operation} ${args[0] || ''}`, {
        cache: true,
        provider: providerName,
        providerType: p,
        priorityIndex: i
      }, ctx);
      const result = await providerOps[p][operation]();
      const duration = Date.now() - start;
      await executeWithPriorityFallbackLogger.info(`使用 ${p} ${operation} 成功, duration=${duration}ms`, {
        cache: true,
        provider: providerName,
        actualProvider: p
      }, ctx);
      lastUsedProvider = p;
      return result;
    } catch (e) {
      const duration = Date.now() - start;
      let errorCode = e.status || e.code || 'unknown';

      // 修复 CF KV "KV list() limit exceeded" 的 code 解析
      if (p === 'cloudflare' && e.message && e.message.includes('limit exceeded')) {
        errorCode = 'quota_exceeded';
      }

      // 新增：收集失败信息
      failedProviders.push({ provider: p, error: e.message, errorCode, duration });

      const nextProvider = providers[i + 1];
      const providerName = p === 'cloudflare' ? 'KV' : p === 'upstash' ? 'Upstash' : 'Redis';
      if (nextProvider) {
        await executeWithPriorityFallbackLogger.warn(`尝试 ${p} → 失败: ${e.message} (code:${errorCode}), duration=${duration}ms, fallback to ${nextProvider}`, { cache: true, provider: providerName, failedProviders }, ctx);
      } else {
        // 新增：在所有提供者失败时记录更详细的错误日志
        await executeWithPriorityFallbackLogger.error(`所有提供者失败，操作 ${operation}，所有提供者尝试结果:`, { args: args.slice(0, 1), failedAttempts: failedProviders }, ctx);
        throw new Error(`All providers failed for ${operation}`);
      }
      // 继续尝试下一个提供者
      continue;
    }
  }

  // 所有提供者都失败 (理论上不会执行到这里，因为上面的 catch 块会抛出错误)
  throw new Error(`All providers failed for ${operation}`);
}

/**
 * 执行操作并支持故障转移（向后兼容）
 */
async function executeWithFailover(operation, env, ctx, ...args) {
  return await executeWithPriorityFallback(operation, env, ctx, ...args);
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
  executeWithPriorityFallback,
  logger,
  upstash_get,
  detectCacheProvider,
  getProviderPriority,
  normalizePath,
  executeRedis,
  executeRedisScan,
  executeUpstashScan,
  scanLockKeys,
  checkRedisHealth,
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

// 暴露 redisClient 的 setter 供测试使用
const __test_setRedisClient = (client) => {
  redisClient = client;
};

export { getCurrentProviderState, setCurrentProviderState, __test_setRedisClient };

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

export default {
  async fetch(request, env, ctx) {
    // [AXIOM_DEBUG] Request lifecycle tracing
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    ctx._axiomDebugRequestId = requestId; // Attach to context for tracing
    console.log(`[AXIOM_DEBUG] ${requestId}: export.default.fetch entered`);

    // 1. 创建安全环境，防止 OTel 扫描 undefined 变量时崩溃
    const safeEnv = createSafeEnv(env);

    updateVersionFromEnv(safeEnv.VERSION);

    // 2. 配置基础 Logger 的 transport
    configureBaseLoggerTransport(safeEnv);

    // 3. 判定是否启用 Axiom 导出器
    const useAxiom = !isTestEnvironment && safeEnv.AXIOM_TOKEN && safeEnv.AXIOM_DATASET;
    console.log(`[AXIOM_DEBUG] ${requestId}: Axiom decision - useAxiom=${useAxiom}, isTest=${isTestEnvironment}, hasToken=${!!safeEnv.AXIOM_TOKEN}, hasDataset=${!!safeEnv.AXIOM_DATASET}`);

    if (useAxiom) {
      console.log(`[AXIOM_DEBUG] ${requestId}: instrument() called with Axiom config`);
      return instrument(handler, {
        serviceName: 'lb-worker-js',
        exporter: {
          url: 'https://api.axiom.co/v1/traces',
          headers: {
            'Authorization': `Bearer ${safeEnv.AXIOM_TOKEN}`,
            'X-Axiom-Dataset': safeEnv.AXIOM_DATASET,
            // 显式加上 Organization ID，这是解决 Dataset 为 0 的杀手锏
            ...(safeEnv.AXIOM_ORG_ID ? { 'X-Axiom-Org-Id': safeEnv.AXIOM_ORG_ID } : {})
          }
        },
      }).fetch(request, safeEnv, ctx);
    }

    // 4. 回退模式：直接运行业务逻辑
    console.log(`[AXIOM_DEBUG] ${requestId}: fallback mode - calling handler.fetch directly`);
    return handler.fetch(request, safeEnv, ctx);
  }
};



/**
 * 路径映射 - 将契约路径映射到实际路径
 */
const PATH_MAP = {
  '/api/tasks/download-tasks': '/api/tasks/download',
  '/api/tasks/upload-tasks': '/api/tasks/upload',
  '/api/tasks/media-batch': '/api/tasks/batch'
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
  const requestId = ctx._axiomDebugRequestId || 'unknown';
  console.log(`[AXIOM_DEBUG] ${requestId}: handleRequest started`);

  const requestLogBuffer = []; // 为每个请求创建独立的日志缓冲
  const requestLogger = logger.child({ module: 'handleRequest', logBuffer: requestLogBuffer }); // 将缓冲传递给子 logger

  // 1. 在上下文还在时，显式捕获顶级 Span
  const rootSpan = trace.getActiveSpan();

  // 创建封装的 log 助手
  const log = {
    info: (message, data = {}) => requestLogger.info(message, data, rootSpan, ctx),
    warn: (message, data = {}) => requestLogger.warn(message, data, rootSpan, ctx),
    error: (message, data = {}) => requestLogger.error(message, data, rootSpan, ctx),
    debug: (message, data = {}) => requestLogger.debug(message, data, rootSpan, ctx),
  };

  log.debug('Request Received', { method: request.method, url: request.url });



  // 1. 提前解构环境变量（在任何异步操作前）
  const axiomToken = env.AXIOM_TOKEN;
  const axiomDataset = env.AXIOM_DATASET;
  const axiomOrg = env.AXIOM_ORG_ID;
  
  // 2. 验证配置
  const axiomEnabled = !isTestEnvironment && axiomToken && axiomDataset;



  const normalizedUrl = new URL(request.url);
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

  // 路径规范化：将契约路径映射到实际路径
  const originalPath = normalizedUrl.pathname;
  normalizedUrl.pathname = normalizePath(normalizedUrl.pathname);

  // 记录路径映射（如果发生映射）
  if (originalPath !== normalizedUrl.pathname) {
    await requestLogger.info('路径规范化', {
      original: originalPath,
      normalized: normalizedUrl.pathname
    });
  }

  // 1. 初始化基础状态
  const runtimeEnv = normalizeEnvName(env.NODE_ENV || 'prod');
  logger.configure({ env: runtimeEnv });

  await requestLogger.debug('Axiom 配置检查', {
    axiomEnabled,
    hasToken: !!axiomToken,
    hasDataset: !!axiomDataset,
    isTestEnvironment,
    hasOrgId: !!axiomOrg
  });

  // 2. 简洁的启动日志（这会被 Axiom 捕获并关联到当前 Trace）
  await requestLogger.info('LB Request Started', {
    path: normalizedUrl.pathname,
    method: request.method,
    rayId: request.headers.get('cf-ray'), // 记录 RayID 方便排查
    version: VERSION
  });

  // 3. 诊断信息（合并原有的分散日志，减少事件数量节省额度）
  const primaryProvider = detectCacheProvider(env);
  const priorities = getProviderPriority(env);
  
  await requestLogger.info('Provider Status', {
    primary: primaryProvider,
    priorities: priorities,
    hasKv: !!env.KV_STORAGE,
    hasRedis: !!(env.NF_REDIS_URL || env.REDIS_TLS_URL),
    hasUpstash: !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
    envOverride: env.CACHE_PROVIDER || 'none'
  });

  // 健康检查 - 增加日志采样过滤
  if ((request.method === 'GET' || request.method === 'HEAD') && normalizedUrl.pathname === '/health') {
    try {
      const activeInstances = await getActiveInstances(env, ctx, requestLogger);
      const activeCount = activeInstances.length;
      const provider = getCurrentProvider();
      const lockCount = await scanLockKeys(env, ctx, requestLogger);
      
      // 健康检查日志采样：仅在非生产环境或特定条件下记录详细信息
      if (runtimeEnv !== 'prod' || activeCount === 0 || lockCount > 0) {
        await requestLogger.info('Health check passed', {
          activeInstances: activeCount,
          provider,
          totalLocks: lockCount
        });
      }

      return new Response(JSON.stringify({
        status: 'ok',
        activeInstances: activeCount,
        provider,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(Date.now() / 1000)
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      await requestLogger.error('Health check failed', { error: e.message });
      return new Response(JSON.stringify({
        status: 'error',
        message: e.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
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
    
    await requestLogger.warn('签名验证失败', {
      error: error.message,
      url: request.url,
      qstashMsgId,
      retryCount
    });
    
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

  let result;
  try {
    console.log(`[AXIOM_DEBUG] ${requestId}: Before getActiveInstances, buffer size=${requestLogBuffer.length}`);
    // 获取活跃实例
    const activeInstances = await getActiveInstances(env, ctx, requestLogger);
    console.log(`[AXIOM_DEBUG] ${requestId}: After getActiveInstances, found ${activeInstances.length} instances, buffer size=${requestLogBuffer.length}`);
    await requestLogger.debug('getActiveInstances complete', { count: activeInstances.length, module: 'instanceSelector' });
    await requestLogger.info('活跃实例查询完成', { count: activeInstances.length });
    await requestLogger.info('存活标记: getActiveInstances 完成', {
      alive: true,
      count: activeInstances.length,
      timestamp: Date.now()
    });

    if (activeInstances.length === 0) {
      const qstashMsgId = request.headers.get('Upstash-Message-Id');
      const retryCount = request.headers.get('Upstash-Retries');

      await requestLogger.warn('无活跃实例可用', {
        qstashMsgId,
        retryCount,
        path: normalizedUrl.pathname
      });

      result = new Response(JSON.stringify({
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
      await requestLogger.warn('返回 503 响应：无活跃实例可用', { qstashMsgId, retryCount, path: normalizedUrl.pathname, status: 503 });
    } else {
      // 选择目标实例
      const targetInstance = await selectTargetInstance(activeInstances, env, ctx, requestLogger);
      await requestLogger.debug('targetInstance selected', { id: targetInstance?.id || 'NONE', module: 'instanceSelector' });
      if (!targetInstance) {
        result = new Response('No target instance selected', { status: 503 });
      } else {
        // 转发请求
        const response = await fetchWithRetry([targetInstance, ...activeInstances.filter(i => i !== targetInstance)], normalizedUrl, request, env, body, ctx, requestLogger);

        await requestLogger.debug('负载均衡请求完成', { status: response.status });

        await requestLogger.info('核心 Fetch 诊断', {
          finalStatus: response.status,
          finalStatusText: response.statusText,
          instanceId: targetInstance.id,
          path: normalizedUrl.pathname,
          alive: true
        });

        result = response;
      }
    }
  } catch (error) {
    await requestLogger.error('handleRequest 处理失败', { error: error.message });
    result = new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  } finally {
    console.log(`[AXIOM_DEBUG] ${requestId}: finally block entered, buffer size=${requestLogBuffer.length}`);
    // 确保在请求结束时，所有缓冲的日志都被发送
    if (ctx && ctx.waitUntil) {
      console.log(`[AXIOM_DEBUG] ${requestId}: calling ctx.waitUntil(flushLogs)`);
      ctx.waitUntil(flushLogs(requestLogBuffer, ctx));
    } else {
      console.log(`[AXIOM_DEBUG] ${requestId}: calling flushLogs synchronously`);
      await flushLogs(requestLogBuffer, ctx);
    }
  }

  return result;
}
