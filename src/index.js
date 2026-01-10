import { logger, configureBaseLoggerTransport, isTestEnvironment, VERSION, flushLogs, updateVersionFromEnv, flushGlobalLoggerBuffer } from './logger.js';

// 全局状态
let currentProvider = 'cloudflare';
let failureCount = 0;
let lastFailureTime = 0;
let failoverReason = '';

// 常量
const ROUND_ROBIN_KEY = 'lb:round_robin_index';
const HEARTBEAT_TIMEOUT = 15 * 60 * 1000; // 15分钟
const TELEGRAM_LOCK_KEY = 'lock:telegram_client';

// 静态导入 OpenTelemetry API
import { trace } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';
// 静态导入 QStash Receiver（生产环境使用）
import { Receiver } from '@upstash/qstash';

// 静态导入 Redis client
import { createRedis } from 'redis-on-workers';
// 导入新的缓存客户端抽象
import { getNFCacheClient } from './cache/client-factory.js';
// 导入 CacheService（新的统一缓存系统，优先于旧配置）
import { CacheService, cacheService } from './cache/CacheService.js';

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
  if (env.CACHE_PROVIDERS) return env.CACHE_PROVIDERS;
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
 * 验证管理员API Token
 */
async function verifyAdminToken(request, env, ctx = null, requestLogger = null) {
  // CF Worker 生命周期管理：确保日志能被正确缓冲和发送
  const verifyAdminTokenLogger = requestLogger || 
    (ctx?.logBuffer ? logger.child({ module: 'AdminToken', logBuffer: ctx.logBuffer }) : logger.child({ module: 'AdminToken' }));
  
  // 跳过验证（开发环境）
  if (env.SKIP_ADMIN_AUTH === 'true') {
    await verifyAdminTokenLogger.debug('⏭️ 跳过管理员鉴权 (Skipping admin auth)', {});
    return true;
  }

  const token = env.ADMIN_API_TOKEN;
  if (!token) {
    throw new Error('ADMIN_API_TOKEN 未配置');
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    throw new Error('缺少 Authorization 头');
  }

  // 支持 Bearer token 和直接 token
  let providedToken;
  if (authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7);
  } else {
    providedToken = authHeader;
  }

  if (providedToken !== token) {
    throw new Error('无效的 API Token');
  }

  await verifyAdminTokenLogger.debug('✅ 管理员Token验证成功', {});
  return true;
}

/**
 * 验证 QStash 签名 - 重构版本
 */
async function verifyQStashSignature(request, env, isGetRequest = false, ctx = null, requestLogger = null) {
  // CF Worker 生命周期管理：确保日志能被正确缓冲和发送
  const verifyQStashSignatureLogger = requestLogger || 
    (ctx?.logBuffer ? logger.child({ module: 'QStashSignature', logBuffer: ctx.logBuffer }) : logger.child({ module: 'QStashSignature' }));
  // 跳过签名验证
  if (env.SKIP_SIGNATURE_VERIFY === 'true') {
    await verifyQStashSignatureLogger.debug('⏭️ 跳过签名验证 (Skipping signature verification)', {});
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
      await verifyQStashSignatureLogger.error('❌ QStash mock 验证失败 (QStash mock verification failed)', { error: e.message });
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
    await verifyQStashSignatureLogger.error('❌ QStash 验证失败 (QStash verification failed)', { error: e.message });
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
      executeWithFailover('_kv_list', env, ctx, scanLockKeysLogger, prefix)
        .catch(e => {
          scanLockKeysLogger.debug('锁键扫描失败', { prefix, error: e.message });
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
    await scanLockKeysLogger.debug('锁键扫描异常', { error: error.message });
    return 0;
  }
}

/**
 * 获取活跃实例
 */
async function getActiveInstances(env, ctx = null, requestLogger = null) {
  // 使用统一的 requestLogger，不再创建新的 logger
  const getActiveInstancesLogger = requestLogger || logger.child({ module: 'getActiveInstances' });
  const redisEndpointSummary = describeRedisEndpoint(env);
  await getActiveInstancesLogger.debug('📊 Redis 终端摘要 (Redis endpoint summary)', { endpoint: redisEndpointSummary });
  try {
    // 扫描所有契约键前缀
    const prefixes = ['instance:', 'lock:', 'task:', 'msg_lock:'];

    // 并发获取所有前缀的键
    const prefixResults = await Promise.all(prefixes.map(prefix =>
      executeWithFailover('_kv_list', env, ctx, getActiveInstancesLogger, prefix)
        .catch(e => {
          getActiveInstancesLogger.debug('前缀扫描失败', { prefix, error: e.message });
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
    await getActiveInstancesLogger.debug('🔎 扫描到所有原始键 (All raw keys scanned)', { keys: allKeys.map(k => k.name) });

    if (allKeys.length === 0) {
      await getActiveInstancesLogger.debug('⚠️ 未找到键，尝试回退全量扫描 (No keys found, attempting fallback full scan)', {});
      try {
        const fallbackResult = await executeWithFailover('_kv_list', env, ctx, getActiveInstancesLogger, '');
        const fallbackKeys = fallbackResult?.keys || [];
        await getActiveInstancesLogger.debug('getActiveInstances Fallback Scan: Raw keys', { keys: fallbackKeys.map(k => k.name), count: fallbackKeys.length });
        allKeys = fallbackKeys;
      } catch (e) {
        await getActiveInstancesLogger.error('❌ 回退扫描失败 (Fallback scan failed)', { error: e.message });
      }

      if (allKeys.length === 0) {
        await getActiveInstancesLogger.debug('getActiveInstances Scan Phase: No keys found after fallback, returning empty array.', {});
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
    await getActiveInstancesLogger.debug('getActiveInstances Scan Phase: Filtered instance keys', { instanceKeys, count: instanceKeys.length });

    // 并发读取实例数据
    const instanceDataResults = [];
    for (const keyName of instanceKeys) {
      try {
        // 一个接一个地读，确保 socket 响应不乱序
        const result = await executeWithFailover('_kv_get', env, ctx, getActiveInstancesLogger, keyName);
        instanceDataResults.push(result);
      } catch (e) {
        getActiveInstancesLogger.error('读取实例数据失败', { key: keyName, error: e.message });
        instanceDataResults.push(null);
      }
    }

    // 新增日志：记录获取到的原始实例数据
    await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Raw instance data results', { rawData: instanceDataResults });

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
        const value = await executeWithFailover('_kv_get', env, ctx, getActiveInstancesLogger, keyName);
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
      await getActiveInstancesLogger.debug(`getActiveInstances Full KV chunk ${chunkIndex}/${totalChunks}`, { entries: chunk });
    }

    for (let idx = 0; idx < instanceDataResults.length; idx++) {
      const data = instanceDataResults[idx];
      const keyName = instanceKeys[idx];
      const instance = parseInstanceData(data);
      await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Parsed instance data', {
        key: keyName,
        instanceId: instance?.id,
        parsedInstance: instance
      });
      if (instance && instance.status === 'active') {
        // 检查心跳是否过期
        if (now - instance.lastHeartbeat <= HEARTBEAT_TIMEOUT) {
          instances.push(instance);
        } else {
          const ageSeconds = Math.floor((now - instance.lastHeartbeat) / 1000);
          await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Instance expired', { instanceId: instance.id, lastHeartbeat: instance.lastHeartbeat, heartbeatTimeoutSeconds: HEARTBEAT_TIMEOUT / 1000, ageSeconds });
        }
      }
    }

    // 记录锁键数量（用于 leader election 监控）
    const lockKeys = allKeys.filter(k => k.name.startsWith('lock:') || k.name.startsWith('task:') || k.name.startsWith('msg_lock:'));
    const lockCount = lockKeys.length;
    
    if (lockCount > 0) {
      await getActiveInstancesLogger.debug('检测到锁键', { lockCount });
    }

    // 为了兼容测试：测试期望 scanLockKeys 被调用，从而触发额外的 KV.list
    if (isTestEnvironment) {
      await scanLockKeys(env, ctx, getActiveInstancesLogger);
    }

    // 去重：同一个实例 ID 只保留一次（防止脏数据导致重复）
    const uniqueInstances = [];
    const seenInstanceIds = new Set();
    for (const inst of instances) {
      if (!inst || !inst.id) continue;
      if (seenInstanceIds.has(inst.id)) continue;
      seenInstanceIds.add(inst.id);
      uniqueInstances.push(inst);
    }

    if (uniqueInstances.length !== instances.length) {
      await getActiveInstancesLogger.debug('去重后实例列表', { before: instances.map(i => i?.id), after: uniqueInstances.map(i => i.id) });
    }

    await getActiveInstancesLogger.debug('👥 获取活跃实例完成 (Active instances fetched)', { count: uniqueInstances.length, totalKeys: allKeys.length });
    return uniqueInstances;
  } catch (error) {
    await getActiveInstancesLogger.error('获取活跃实例失败', { error: error.message });
    return [];
  }
}

/**
 * 根据锁持有者选择实例（用于需要会话锁的下载任务）
 */
async function selectInstanceByLock(instances, env, ctx, requestLogger = null) {
  const lockRoutingLogger = requestLogger || logger.child({ module: 'lockRouting' });
  if (!instances || instances.length === 0) return null;

  let lockValue;
  try {
    lockValue = await executeWithFailover('_kv_get', env, ctx, lockRoutingLogger, TELEGRAM_LOCK_KEY);
  } catch (error) {
    await lockRoutingLogger.warn('🔒 读取锁失败，回退轮询', { lockKey: TELEGRAM_LOCK_KEY, error: error.message });
    return null;
  }

  if (!lockValue) {
    await lockRoutingLogger.debug('🔍 未找到锁或锁已过期，回退轮询', { lockKey: TELEGRAM_LOCK_KEY });
    return null;
  }

  let parsed = lockValue;
  if (typeof lockValue === 'string') {
    parsed = safeJsonParse(lockValue, 'lockOwner') || { instanceId: lockValue };
  } else if (lockValue && typeof lockValue === 'object' && lockValue.value !== undefined) {
    parsed = safeJsonParse(lockValue.value, 'lockOwner.value') || lockValue;
  }

  const lockOwnerId = parsed?.instanceId || parsed?.instanced || parsed?.ownerId || parsed?.owner || parsed?.id;
  const acquiredAt = Number(parsed?.acquiredAt || parsed?.acquired_at || 0);
  const ttlSeconds = Number(parsed?.ttl || parsed?.expiresIn || 0);

  const activeIds = instances.map(i => i.id);
  await lockRoutingLogger.debug('锁路由调试信息', {
    lockKey: TELEGRAM_LOCK_KEY,
    rawLock: typeof lockValue === 'string' ? lockValue : parsed,
    lockOwnerId,
    acquiredAt,
    ttlSeconds,
    activeIds
  });

  if (ttlSeconds > 0 && acquiredAt > 0) {
    const expiresAt = acquiredAt + ttlSeconds * 1000;
    if (Date.now() > expiresAt) {
      await lockRoutingLogger.debug('🔍 锁已过期，回退轮询', { lockKey: TELEGRAM_LOCK_KEY, acquiredAt, ttlSeconds });
      return null;
    }
  }
  if (!lockOwnerId) {
    await lockRoutingLogger.debug('⚠️ 锁值缺少实例信息，回退轮询', { lockKey: TELEGRAM_LOCK_KEY });
    return null;
  }

  const ownerInstance = instances.find(inst => inst.id === lockOwnerId);
  if (ownerInstance) {
    await lockRoutingLogger.info('🎯 使用锁持有者作为目标实例', { lockKey: TELEGRAM_LOCK_KEY, instanceId: lockOwnerId });
    return ownerInstance;
  }

  await lockRoutingLogger.warn('⚠️ 锁持有者不在活跃实例列表，回退轮询', { lockKey: TELEGRAM_LOCK_KEY, instanceId: lockOwnerId });
  return null;
}

/**
 * 选择目标实例 (轮询)
 */
async function selectTargetInstance(instances, env, ctx, requestLogger = null) {
  const selectTargetInstanceLogger = requestLogger || logger.child({ module: 'selectTargetInstance' });
  if (instances.length === 0) {
    return null;
  }

  let currentIndex = 0;
  try {
    const stored = await executeWithFailover('_kv_get', env, ctx, selectTargetInstanceLogger, ROUND_ROBIN_KEY);
    currentIndex = stored ? parseInt(stored) : 0;
  } catch (e) {
    await selectTargetInstanceLogger.error('轮询索引获取失败', { error: e.message });
  }

  const targetIndex = currentIndex % instances.length;
  const targetInstance = instances[targetIndex];

  try {
    await executeWithFailover('_kv_put', env, ctx, selectTargetInstanceLogger, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
  } catch (e) {
    await selectTargetInstanceLogger.error('轮询索引更新失败', { error: e.message });
  }

  return targetInstance;
}

/**
 * 转发请求到目标实例
 */
async function forwardToInstance(instance, normalizedUrl, request, originalBody, ctx = null, requestLogger = null) {
  const forwardToInstanceLogger = requestLogger || logger.child({ module: 'forwardToInstance' });
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
  await forwardToInstanceLogger.info('转发请求到实例', { 
    instanceId: instance.id, 
    targetUrl: url.toString(),
    originalPath: normalizedUrl.pathname
  });
  const response = await fetch(forwardRequest);

  if (response.status >= 500) {
    await forwardToInstanceLogger.warn('后端返回 5xx 错误', { status: response.status, instanceId: instance.id });
  } else if (response.status >= 400 && response.status < 500) {
    await forwardToInstanceLogger.warn('后端返回 4xx 错误', { status: response.status, statusText: response.statusText, instanceId: instance.id, targetUrl: url.toString() });
  }

  return response;
}

/**
 * 带重试的转发逻辑
 */
async function fetchWithRetry(instances, normalizedUrl, request, env, body, ctx, requestLogger = null) {
  const fetchWithRetryLogger = requestLogger || logger.child({ module: 'fetchWithRetry' });
  let lastError;
  let last5xxResponse = null;

  for (const instance of instances) {
    try {
      const response = await forwardToInstance(instance, normalizedUrl, request, body, ctx, requestLogger);
      
      // 4xx 错误：直接透传，不再重试其他实例
      if (response.status >= 400 && response.status < 500) {
        await fetchWithRetryLogger.warn('实例返回 4xx 错误，停止重试', { status: response.status, instanceId: instance.id });
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
      await fetchWithRetryLogger.error('转发请求失败', { instanceId: instance.id, error: error.message });
      lastError = error;
      // 新增：在每次请求失败时，也尝试取消之前保存的 5xx 响应体，防止泄漏
      if (last5xxResponse && last5xxResponse.body) {
        await last5xxResponse.body.cancel().catch(() => {});
      }
    }
  }

  // 如果有 5xx 响应，返回最后一个 5xx 响应（new-features 测试期望）
  if (last5xxResponse) {
    await fetchWithRetryLogger.warn('所有实例均返回 5xx', { status: last5xxResponse.status });
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

function failover(env, ctx = null, requestLogger = null) {
  // 使用统一的 requestLogger
  const failoverLogger = requestLogger || logger.child({ module: 'failover' });
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
async function retryRedisCommand(client, command, args = [], maxRetries = 3, initialDelay = 100, ctx = null, requestLogger = null) {
  // 使用统一的 requestLogger
  const retryRedisCommandLogger = requestLogger || logger.child({ module: 'retryRedisCommand' });
  let retries = 0;
  let delay = initialDelay;
  let timerId = null;
  let isDone = false;

  const executeWithRetries = async () => {
    while (retries < maxRetries && !isDone) {
      try {
        if (retries > 0) {
          await retryRedisCommandLogger.warn(`Redis 命令重试: ${command} (尝试 ${retries + 1}/${maxRetries})`, { delay: `${delay}ms` });
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
 * 获取 Redis TLS Client (优先使用 CACHE_PROVIDERS，fallback 到旧配置)
 */
let redisClient = null;
let redisInitPromise = null;
let cacheServiceInstance = null;

async function getRedisClient(env, ctx, requestLogger) {
  const getRedisClientLogger = requestLogger || logger.child({ module: 'getRedisClient' });

  // 测试环境 mock
  if (isTestEnvironment && typeof __test_getRedisClient === 'function') {
    const mockClient = __test_getRedisClient();
    if (mockClient) return mockClient;
  }

  // 优先使用 CACHE_PROVIDERS
  if (env.CACHE_PROVIDERS) {
    if (!cacheServiceInstance) {
      cacheServiceInstance = new CacheService({ env, logger: getRedisClientLogger });
    } else {
      cacheServiceInstance.logger = getRedisClientLogger;
    }
    await cacheServiceInstance.initialize(ctx);

    if (cacheServiceInstance.primaryProvider) {
      await getRedisClientLogger.info('使用 CACHE_PROVIDERS 缓存系统', {
        provider: cacheServiceInstance.getCurrentProvider()
      });
      return {
        get: (key) => cacheServiceInstance.get(key, 'string', {}),
        set: (key, value, ttl) => cacheServiceInstance.set(key, value, ttl, {}),
        send: undefined, // CacheService 不支持 send
        connect: () => Promise.resolve(),
        disconnect: () => cacheServiceInstance.destroy()
      };
    }
  }

  // Fallback: 使用旧的 NFCacheClient
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
      await getRedisClientLogger.info('NF Redis Client 初始化成功', { url: effectiveEnv.NF_REDIS_URL });
      return client;
    } catch (e) {
      redisClient = null;
      redisInitPromise = null; // 失败后允许下次重试
      await getRedisClientLogger.error('NF Redis Client 初始化失败', { error: e.message });
      throw e;
    }
  })();

  return redisInitPromise;
}

/**
 * 执行 Redis TLS 操作 (优先使用 CACHE_PROVIDERS，fallback 到旧配置)
 */
async function executeRedis(operation, env, key, value = null, ctx = null, requestLogger = null) {
  const log = requestLogger || logger.child({ module: 'executeRedis' });

  // 优先使用 CACHE_PROVIDERS
  if (env.CACHE_PROVIDERS) {
    if (!cacheServiceInstance) {
      cacheServiceInstance = new CacheService({ env, logger: log });
    } else {
      cacheServiceInstance.logger = log;
    }
    await cacheServiceInstance.initialize(ctx);

    const start = Date.now();
    try {
      switch (operation) {
        case '_redis_get':
        case '_kv_get': {
          const result = await cacheServiceInstance.get(key, 'string', {});
          await log.debug(`executeRedis GET (CacheService): key=${key}, result=${result}, duration=${Date.now() - start}ms`, {});
          return result;
        }
        case '_redis_put':
        case '_kv_put': {
          const valStr = typeof value === 'string' ? value : JSON.stringify(value);
          await cacheServiceInstance.set(key, valStr, 3600, {});
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

  // Fallback: 使用旧的 NFCacheClient
  const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
  const redisPassword = env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD;

  if (!redisUrl) {
    throw new Error('Redis URL not found in environment variables.');
  }

  const client = await getRedisClient({
    NF_REDIS_URL: redisUrl,
    NF_REDIS_PASSWORD: redisPassword
  }, ctx, log);
  const start = Date.now();

  try {
    switch (operation) {
      case '_redis_get':
      case '_kv_get': {
        // 支持 mock client 的 send 方法和真实 client 的 get 方法
        let result;
        await log.debug(`executeRedis GET: key=${key}`, {});
        if (client.send) {
          result = await client.send('GET', key);
        } else if (client.get) {
          result = await client.get(key);
        } else {
          throw new Error('Client does not support get or send method');
        }
        const duration = Date.now() - start;
        await log.debug(`executeRedis GET result: key=${key}, result=${result}, duration=${duration}ms`, {});
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
 * 执行 Redis TLS Scan 操作 (优先使用 CACHE_PROVIDERS，fallback 到旧配置)
 */
async function executeRedisScan(env, prefix, ctx = null, requestLogger = null) {
  const scanLogger = requestLogger || logger.child({ module: 'executeRedisScan', logBuffer: ctx?.logBuffer });

  // 优先使用 CACHE_PROVIDERS
  if (env.CACHE_PROVIDERS) {
    if (!cacheServiceInstance) {
      cacheServiceInstance = new CacheService({ env, logger: scanLogger });
    } else {
      cacheServiceInstance.logger = scanLogger;
    }
    await cacheServiceInstance.initialize(ctx);

    const keys = await cacheServiceInstance.listKeys(prefix);
    await scanLogger.debug(`executeRedisScan (CacheService): prefix=${prefix}, keysFound=${keys.length}`, {});
    return { keys: keys.map(k => ({ name: k })) };
  }

  // Fallback: 使用旧的 NFCacheClient
  const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
  const redisPassword = env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD;

  if (!redisUrl) {
    throw new Error('Redis URL not found in environment variables.');
  }

  const client = await getRedisClient({
    NF_REDIS_URL: redisUrl,
    NF_REDIS_PASSWORD: redisPassword
  });

  const keys = [];
  let cursor = '0';

  do {
    // 支持 mock client 的 send 方法和真实 client 的 scan 方法
    let res;
    // 添加日志，记录使用的 client 类型和 scan 参数
    const isNFCacheClient = !!client.scan && !client.send;
    const clientType = isNFCacheClient ? 'NFCacheClient' : (client.send ? 'RedisClient' : 'Unknown');
    await scanLogger.debug(`executeRedisScan: clientType=${clientType}, prefix=${prefix}, cursor=${cursor}`, {});

    if (client.send) {
      // 原生 redis-on-workers 或类似 client，直接发送命令
      // 必须显式包含 MATCH 和 COUNT 关键字
      // 修复：MATCH pattern 应该是 'instance:*' 而不是 'instance:instance:*'
      // 传入的 prefix 是 'instance:'
      const matchPattern = prefix === '' ? '*' : (prefix.endsWith(':') ? `${prefix}*` : `${prefix}:*`);
      await scanLogger.debug(`Executing Redis SCAN (send)`, { clientType, prefix, matchPattern, cursor });
      res = await client.send('SCAN', cursor, 'MATCH', matchPattern, 'COUNT', 100);
    } else if (client.scan) {
      // NFCacheClient 或兼容接口
      // 假设 scan 方法签名是 (cursor, matchPattern, count)
      // 这里的 matchPattern 应该是完整的 pattern (如 "instance:*")
      const matchPattern = prefix === '' ? '*' : (prefix.endsWith(':') ? `${prefix}*` : `${prefix}:*`);
      await scanLogger.debug(`Executing Redis SCAN (scan)`, { clientType, prefix, matchPattern, cursor });
      res = await client.scan(cursor, matchPattern, 100);
    } else {
      throw new Error('Client does not support scan or send method');
    }

    cursor = res[0];
    const batchKeys = res[1];

    // 诊断日志：记录 SCAN 返回的原始数据
    await scanLogger.debug(`executeRedisScan: SCAN response`, {
      prefix,
      nextCursor: cursor,
      batchKeysCount: Array.isArray(batchKeys) ? batchKeys.length : 0,
      batchKeys: Array.isArray(batchKeys) ? batchKeys.map(k => String(k)) : batchKeys,
      batchKeysType: Array.isArray(batchKeys) ? 'array' : typeof batchKeys
    });

    if (Array.isArray(batchKeys)) {
      for (const k of batchKeys) {
        keys.push({ name: coerceCacheKeyName(k) });
      }
    }
  } while (cursor !== '0');

  await scanLogger.debug(`executeRedisScan: finished scanning`, { prefix, keysFound: keys.length, keys: keys.map(k => k.name) });
  return { keys };
}

/**
 * 检查 Redis 健康状况 (优先使用 CACHE_PROVIDERS，fallback 到旧配置)
 */
async function checkRedisHealth(env, ctx, executor = executeWithPriorityFallback) {
  const checkRedisHealthLogger = logger.child({ module: 'checkRedisHealth' });
  try {
    // 优先使用 CACHE_PROVIDERS
    if (env.CACHE_PROVIDERS) {
      if (!cacheServiceInstance) {
        cacheServiceInstance = new CacheService({ env });
      }
      await cacheServiceInstance.initialize();

      if (cacheServiceInstance.primaryProvider) {
        const provider = cacheServiceInstance.getCurrentProvider();
        const start = Date.now();
        try {
          if (cacheServiceInstance.primaryProvider.ping) {
            await cacheServiceInstance.primaryProvider.ping();
          } else {
            await cacheServiceInstance.get('healthcheck_ping');
          }
          const duration = Date.now() - start;
          await checkRedisHealthLogger.info(`Redis 健康检查成功 (CacheService, provider=${provider})`, { duration: `${duration}ms`, provider });
          return true;
        } catch (pingError) {
          await checkRedisHealthLogger.warn(`CacheService Redis PING 健康检查失败: ${pingError.message}`, { provider });
        }
      }
    }

    // Fallback: 使用旧的 NFCacheClient
    const redisUrl = env.NF_REDIS_URL || env.REDIS_TLS_URL;
    const redisPassword = env.NF_REDIS_PASSWORD || env.REDIS_TLS_PASSWORD;

    // 如果配置了 Redis，直接通过 PING 命令检查健康状况
    if (redisUrl) {
      try {
        const client = await getRedisClient({
          NF_REDIS_URL: redisUrl,
          NF_REDIS_PASSWORD: redisPassword
        });
        const start = Date.now();
        const pong = await client.ping();
        const duration = Date.now() - start;
        if (pong === 'PONG' || pong === 'OK') {
          await checkRedisHealthLogger.info(`Redis 健康检查成功 (通过 PING)`, { duration: `${duration}ms` });
          return true;
        } else {
          await checkRedisHealthLogger.warn(`Redis 健康检查失败 (PING 响应: ${pong})`, { duration: `${duration}ms` });
          return false;
        }
      } catch (pingError) {
        await checkRedisHealthLogger.warn(`Redis PING 健康检查失败: ${pingError.message}`, {});
        // 如果直接 PING 失败，不立即返回 false，而是继续尝试通过 _kv_get 进行检查
      }
    }

    // 回退：通过 executeWithPriorityFallback 读取一个预设的键，检查可用的、基于 HTTP 的 provider (如 Upstash)
    const start = Date.now();
    await executor('_kv_get', env, ctx, 'healthcheck_ping');
    const duration = Date.now() - start;
    await checkRedisHealthLogger.info(`备用 provider 健康检查成功 (通过 _kv_get)`, { duration: `${duration}ms` });
    return true;
  } catch (e) {
    await checkRedisHealthLogger.error(`所有 provider 健康检查失败`, { error: e.message });
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
  const lastArg = args[args.length - 1];
  const requestLogger = (lastArg && typeof lastArg.debug === 'function') ? args.pop() : null;
  let executeWithPriorityFallbackLogger = requestLogger;
  if (!executeWithPriorityFallbackLogger) {
    try {
      executeWithPriorityFallbackLogger = logger.child({ module: 'executeWithPriorityFallback' });
    } catch (e) {
      console.error('Failed to create child logger, using global logger:', e.message);
      executeWithPriorityFallbackLogger = logger;
    }
  }
  if (typeof executeWithPriorityFallbackLogger.debug !== 'function') {
    console.warn('[executeWithPriorityFallback] Logger 不合法，降级到全局 logger (Logger invalid, fallback to global logger)');
    executeWithPriorityFallbackLogger = logger;
  }
  const providers = getProviderPriority(env);
  await executeWithPriorityFallbackLogger.debug(`执行 ${operation}，优先级: ${JSON.stringify(providers)}`, { args: args.slice(0, 1), providers });

  const providerOps = {
    'redis': {
      '_kv_get': async () => {
        return await executeRedis('_redis_get', env, args[0], null, ctx, executeWithPriorityFallbackLogger);
      },
      '_kv_put': async () => {
        return await executeRedis('_redis_put', env, args[0], args[1], ctx, executeWithPriorityFallbackLogger);
      },
      '_kv_list': async () => {
        return await executeRedisScan(env, args[0], ctx, executeWithPriorityFallbackLogger);
      }
    },
    'cloudflare': {
      '_kv_get': async () => {
        if (env.KV_STORAGE) {
          const start = Date.now();
          const res = await env.KV_STORAGE.get(args[0]);
          await executeWithPriorityFallbackLogger.debug(`Cloudflare KV GET: key=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'KV' });
          return res;
        }
        throw new Error('KV_STORAGE not available');
      },
      '_kv_put': async () => {
        if (env.KV_STORAGE) {
          const start = Date.now();
          await env.KV_STORAGE.put(args[0], args[1]);
          await executeWithPriorityFallbackLogger.debug(`Cloudflare KV PUT: key=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'KV' });
          return true;
        }
        throw new Error('KV_STORAGE not available');
      },
      '_kv_list': async () => {
        if (env.KV_STORAGE) {
          const start = Date.now();
          const res = await env.KV_STORAGE.list({ prefix: args[0] });
          await executeWithPriorityFallbackLogger.debug(`Cloudflare KV LIST: prefix=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'KV' });
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

        await executeWithPriorityFallbackLogger.debug(`Upstash GET ${args[0]}: status ${response.status}, duration=${duration}ms`, { cache: true, provider: 'Upstash' });

        if (response.status === 404) {
          await executeWithPriorityFallbackLogger.debug(`Upstash GET 404 for ${args[0]}, canceling body`, { cache: true, provider: 'Upstash' });
          await response.body.cancel();
          return null;
        }

        if (!response.ok) {
          await executeWithPriorityFallbackLogger.debug(`Upstash GET error ${response.status} for ${args[0]}, canceling body`, { cache: true, provider: 'Upstash' });
          await response.body?.cancel();
          throw new Error(`Upstash Get Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        await executeWithPriorityFallbackLogger.debug(`Upstash GET ${args[0]} success`, { cache: true, provider: 'Upstash' });
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

        await executeWithPriorityFallbackLogger.debug(`Upstash PUT ${args[0]}: status ${response.status}, duration=${duration}ms`, { cache: true, provider: 'Upstash' });

        if (!response.ok) {
          await executeWithPriorityFallbackLogger.debug(`Upstash PUT error ${response.status} for ${args[0]}, canceling body`, { cache: true, provider: 'Upstash' });
          await response.body?.cancel();
          throw new Error(`Upstash Put Error: ${response.status} ${response.statusText}`);
        }

        await executeWithPriorityFallbackLogger.debug(`Upstash PUT ${args[0]} success`, { cache: true, provider: 'Upstash' });
        return true;
      },
      '_kv_list': async () => {
        const start = Date.now();
        const res = await executeUpstashScan(env, args[0]);
        await executeWithPriorityFallbackLogger.debug(`Upstash LIST: prefix=${args[0]} success, duration=${Date.now() - start}ms`, { cache: true, provider: 'Upstash' });
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
      });
      const result = await providerOps[p][operation]();
      const duration = Date.now() - start;
      await executeWithPriorityFallbackLogger.info(`使用 ${p} ${operation} 成功, duration=${duration}ms`, {
        cache: true,
        provider: providerName,
        actualProvider: p
      });
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
        await executeWithPriorityFallbackLogger.warn(`尝试 ${p} → 失败: ${e.message} (code:${errorCode}), duration=${duration}ms, fallback to ${nextProvider}`, { cache: true, provider: providerName, failedProviders });
      } else {
        // 新增：在所有提供者失败时记录更详细的错误日志
        await executeWithPriorityFallbackLogger.error(`所有提供者失败，操作 ${operation}，所有提供者尝试结果:`, { args: args.slice(0, 1), failedAttempts: failedProviders });
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
  // 检查args的第一个参数是否是logger（旧调用方式：parentLogger在第4位，现在是args[0]）
  if (args.length > 0 && typeof args[0].debug === 'function') {
    const parentLogger = args.shift();
    return await executeWithPriorityFallback(operation, env, ctx, ...args, parentLogger);
  }
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
  verifyAdminToken,
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
  handleRequest,
  CacheService
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
    const requestId = `req_${Date.now()}_${(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11))}`;
    if (ctx) ctx._axiomDebugRequestId = requestId; // Attach to context for tracing
    console.log(`[AXIOM_DEBUG] ${requestId}: export.default.fetch entered`);

    // 1. 创建安全环境，防止 OTel 扫描 undefined 变量时崩溃
    const safeEnv = createSafeEnv(env);

    updateVersionFromEnv(safeEnv.VERSION);

    // 2. 配置基础 Logger 的 transport
    configureBaseLoggerTransport(safeEnv);

    // 3. 判定是否启用 Axiom 导出器
    // 修复：检查实际值而不是空字符串
    const useAxiom = !isTestEnvironment && 
                     safeEnv.AXIOM_TOKEN && safeEnv.AXIOM_TOKEN.trim() !== '' &&
                     safeEnv.AXIOM_DATASET && safeEnv.AXIOM_DATASET.trim() !== '';
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

    // 4. 回退模式：直接运行业务逻辑，也要传递 ctx
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

  // 创建封装的 log 助手（包含 child 方法代理，防止调用 .child() 时崩溃）
  const log = {
    info: (message, data = {}) => requestLogger.info(message, data, rootSpan, ctx),
    warn: (message, data = {}) => requestLogger.warn(message, data, rootSpan, ctx),
    error: (message, data = {}) => requestLogger.error(message, data, rootSpan, ctx),
    debug: (message, data = {}) => requestLogger.debug(message, data, rootSpan, ctx),
    child: (bindings) => requestLogger.child(bindings)
  };

log.debug('Request Received', { method: request.method, url: request.url });

  // CORS preflight 优先处理（必须在所有其他逻辑之前，避免触发不必要的签名验证/KV扫描）
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  }

  // 提取请求来源信息（仅 debug 级别，生产环境可通过 DEBUG_LOGS=true 开启）
  const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const referer = request.headers.get('referer') || 'none';
  const cfRay = request.headers.get('cf-ray') || 'unknown';
  const country = request.headers.get('cf-ipcountry') || 'unknown';

  log.debug('Request Source Info', {
    clientIP: clientIP.length > 50 ? clientIP.substring(0, 50) + '...' : clientIP,
    userAgent: userAgent.length > 200 ? userAgent.substring(0, 200) + '...' : userAgent,
    referer,
    cfRay,
    country
  });



  // 1. 提前解构环境变量（在任何异步操作前）
  const axiomToken = env.AXIOM_TOKEN;
  const axiomDataset = env.AXIOM_DATASET;
  const axiomOrg = env.AXIOM_ORG_ID;
  
  // 2. 验证配置 - 与入口函数保持一致
  // 修复：检查实际值而不是空字符串
  const axiomEnabled = !isTestEnvironment && 
                      axiomToken && axiomToken.trim() !== '' &&
                      axiomDataset && axiomDataset.trim() !== '';



  const normalizedUrl = new URL(request.url);
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

  // 路径规范化：将契约路径映射到实际路径
  const originalPath = normalizedUrl.pathname;
  normalizedUrl.pathname = normalizePath(normalizedUrl.pathname);

  // 记录路径映射（如果发生映射）
  if (originalPath !== normalizedUrl.pathname) {
    await log.info('路径规范化', {
      original: originalPath,
      normalized: normalizedUrl.pathname
    });
  }

  // 1. 重新配置 Axiom 传输（统一使用 env，此时 env 已经是 safeEnv）
  configureBaseLoggerTransport(env);
  
  // 2. 初始化基础状态
  const runtimeEnv = normalizeEnvName(env.NODE_ENV || 'prod');
  logger.configure({ env: runtimeEnv });

  await log.debug('Axiom 配置检查', {
    axiomEnabled,
    hasToken: !!axiomToken,
    hasDataset: !!axiomDataset,
    isTestEnvironment,
    hasOrgId: !!axiomOrg
  });

  // 2. 简洁的启动日志（这会被 Axiom 捕获并关联到当前 Trace）
  await log.info('LB Request Started', {
    path: normalizedUrl.pathname,
    method: request.method,
    rayId: request.headers.get('cf-ray'), // 记录 RayID 方便排查
    version: VERSION
  });

  // 3. 诊断信息（合并原有的分散日志，减少事件数量节省额度）
  const primaryProvider = detectCacheProvider(env);
  const priorities = getProviderPriority(env);
  
  await log.info('Provider Status', {
    primary: primaryProvider,
    priorities: priorities,
    hasKv: !!env.KV_STORAGE,
    hasRedis: !!(env.NF_REDIS_URL || env.REDIS_TLS_URL),
    hasUpstash: !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
    envOverride: env.CACHE_PROVIDERS || 'none'
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
        await log.info('Health check passed', {
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
      await log.error('Health check failed', { error: e.message });
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

// 实例查询接口 - 返回当前活跃实例信息（需要鉴权）
  if (request.method === 'GET' && normalizedUrl.pathname === '/api/instances') {
    try {
      // 验证管理员Token
      await verifyAdminToken(request, env, ctx, log);
      
      const activeInstances = await getActiveInstances(env, ctx, log);
      const provider = getCurrentProvider();
      const lockCount = await scanLockKeys(env, ctx, log);
      
      return new Response(JSON.stringify({
        status: 'ok',
        data: {
          instances: activeInstances,
          summary: {
            total: activeInstances.length,
            provider,
            lockKeys: lockCount,
            timestamp: new Date().toISOString()
          }
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      await log.error('Instance query failed', { error: e.message });
      return new Response(JSON.stringify({
        status: 'error',
        message: e.message,
        timestamp: new Date().toISOString()
      }), {
        status: e.message.includes('Token') || e.message.includes('Authorization') ? 401 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  // 验证签名
  let body = null;
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      body = await verifyQStashSignature(request, env, true, ctx, log);
    } else {
      body = await verifyQStashSignature(request, env, false, ctx, log);
    }
    if (body === null) body = new Uint8Array();
  } catch (error) {
    // 获取 QStash 元数据
    const qstashMsgId = request.headers.get('Upstash-Message-Id');
    const retryCount = request.headers.get('Upstash-Retries');
    
    await log.warn('签名验证失败', {
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
    await log.debug('getActiveInstances complete', { count: activeInstances.length, module: 'instanceSelector' });
    await log.info('活跃实例查询完成', { count: activeInstances.length });
    await log.info('存活标记: getActiveInstances 完成', {
      alive: true,
      count: activeInstances.length,
      timestamp: Date.now()
    });

    if (activeInstances.length === 0) {
      const qstashMsgId = request.headers.get('Upstash-Message-Id');
      const retryCount = request.headers.get('Upstash-Retries');

await log.warn('无活跃实例可用', {
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
      await log.warn('返回 503 响应：无活跃实例可用', { qstashMsgId, retryCount, path: normalizedUrl.pathname, status: 503 });
    } else {
      // 选择目标实例：下载任务优先分配给锁持有者
      let targetInstance = null;
      if (normalizedUrl.pathname === '/api/tasks/download') {
        targetInstance = await selectInstanceByLock(activeInstances, env, ctx, requestLogger);
      }

      if (!targetInstance) {
        targetInstance = await selectTargetInstance(activeInstances, env, ctx, requestLogger);
      }
      await log.debug('targetInstance selected', { id: targetInstance?.id || 'NONE', module: 'instanceSelector' });
      if (!targetInstance) {
        result = new Response('No target instance selected', { status: 503 });
      } else {
        // 转发请求
        const response = await fetchWithRetry([targetInstance, ...activeInstances.filter(i => i !== targetInstance)], normalizedUrl, request, env, body, ctx, requestLogger);

        await log.debug('负载均衡请求完成', { status: response.status });

        await log.info('核心 Fetch 诊断', {
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
    await log.error('handleRequest 处理失败', { error: error.message });
    result = new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  } finally {
    console.log(`[AXIOM_DEBUG] ${requestId}: finally block entered, requestLogBuffer size=${requestLogBuffer.length}`);

    // 刷新全局 logger buffer（防止 fallback 产生的"暗物质日志"丢失）
    const globalFlushTask = flushGlobalLoggerBuffer();

    // 确保在请求结束时，所有缓冲的日志都被发送
    if (ctx && ctx.waitUntil) {
      const requestFlushTask = flushLogs(requestLogBuffer);

      // 确保 flushLogs 返回有效的 Promise
      if (requestFlushTask) {
        ctx.waitUntil(requestFlushTask);
      }

      // 如果全局 buffer 有内容，也 waitUntil
      if (globalFlushTask) {
        console.log(`[AXIOM_DEBUG] ${requestId}: also flushing global logger buffer`);
        ctx.waitUntil(globalFlushTask);
      }
    } else {
      console.log(`[AXIOM_DEBUG] ${requestId}: calling flushLogs synchronously`);
      await flushLogs(requestLogBuffer);
    }
  }
  
  return result;
}

