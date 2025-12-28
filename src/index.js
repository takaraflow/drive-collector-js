/**
 * Cloudflare Worker - QStash Webhook Load Balancer
 * 负载均衡器，接收QStash Webhook，转发到活跃实例
 */

import { trace } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';

const config = {
  exporter: {
    url: 'https://api.axiom.co/v1/traces',
  },
  serviceName: 'lb-worker-js',
};

/**
 * 稳健的 JSON 解析函数，支持自动修复无引号键
 */
function safeJsonParse(data, context = '') {
  if (data === null || data === undefined) return null;

  // 如果已经是对象，直接返回
  if (typeof data === 'object') return data;

  try {
    // 首先尝试标准 JSON 解析
    return JSON.parse(data);
  } catch (e) {
    // 尝试修复无引号键的 JSON 格式
    try {
      // 使用正则表达式修复无引号键
      // 匹配 {key:value,key:value} 格式，将键添加引号
      let fixedData = data.trim();

      // 移除外层花括号（如果有）
      if (fixedData.startsWith('{') && fixedData.endsWith('}')) {
        fixedData = fixedData.slice(1, -1);
      }

      // 正则表达式匹配无引号键：单词字符开头，后跟冒号
      // 支持字符串开头和 { 或 , 后的键，避免匹配值中的冒号
      fixedData = fixedData.replace(/(^|[{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

      // 重新添加花括号
      fixedData = `{${fixedData}}`;

      return JSON.parse(fixedData);
    } catch (fixError) {
      // 如果不是有效的 JSON 且无法修复，返回 null
      return null;
    }
  }
}

const logger = {
  env: 'production',

  configure({ env = 'production' }) {
    this.env = env;
  },

  info(message, meta = {}, ctx = null) {
    const span = trace.getActiveSpan();
    if (span) span.addEvent(message, meta);
    console.log(`INFO: ${message}`, meta);
  },

  warn(message, meta = {}, ctx = null) {
    const span = trace.getActiveSpan();
    if (span) {
        span.setStatus({ code: 1, message: message }); // 1 = Error (in some OTel versions, or use attributes)
        span.setAttribute('log.level', 'warn');
        span.addEvent(message, meta);
    }
    console.warn(`WARN: ${message}`, meta);
  },

  error(message, meta = {}, ctx = null) {
    const span = trace.getActiveSpan();
    if (span) {
        span.recordException(message instanceof Error ? message : new Error(message));
        span.setStatus({ code: 2 }); // 2 = Error
    }
    console.error(`ERROR: ${message}`, meta);
  },
   
  debug(message, meta = {}, ctx = null) {
    if (this.env !== 'production') {
      const span = trace.getActiveSpan();
      if (span) span.addEvent(message, meta);
      console.debug(`DEBUG: ${message}`, meta);
    }
  },
   

};

// 常量
const INSTANCE_PREFIX = 'instance:';
const HEARTBEAT_TIMEOUT = 30 * 60 * 1000; // 30分钟
const ROUND_ROBIN_KEY = 'lb:round_robin_index';

// 故障转移配置增强
let currentProvider = 'cloudflare'; // 'cloudflare' | 'upstash'
let failureCount = 0;
let lastFailureTime = 0;
let failoverReason = null; // 'quota' | 'network' | 'other'

const MAX_FAILURES = 3; // 对于非立即降级的错误保留
const QUOTA_RECOVERY_INTERVAL = 12 * 60 * 60 * 1000; // 配额错误恢复间隔：12小时
const NETWORK_RECOVERY_INTERVAL = 30 * 60 * 1000;    // 网络错误恢复间隔：30分钟

/**
 * 检查是否可以恢复到 Cloudflare KV
 */
function checkRecovery(ctx) {
    if (currentProvider !== 'upstash') return;

    const now = Date.now();
    const interval = failoverReason === 'quota' ? QUOTA_RECOVERY_INTERVAL : NETWORK_RECOVERY_INTERVAL;

    if (now - lastFailureTime > interval) {
        logger.info(`达到恢复检查阈值，尝试切回 Cloudflare KV`, { 
            reason: failoverReason,
            lastFailure: new Date(lastFailureTime).toISOString()
        }, ctx);
        // 尝试切回，如果后续操作失败会再次触发 shouldFailover
        currentProvider = 'cloudflare';
        failureCount = 0;
    }
}

/**
 * 检查是否应该触发故障转移
 */
function shouldFailover(error, env, ctx) {
    if (currentProvider === 'upstash' || !env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
        return false;
    }

    const msg = error.message.toLowerCase();
    const isQuotaError = msg.includes('free usage limit') || msg.includes('quota exceeded') || msg.includes('rate limit');
    const isNetworkError = msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout');

    if (isQuotaError || isNetworkError) {
        failoverReason = isQuotaError ? 'quota' : 'network';
        lastFailureTime = Date.now();
        logger.warn(`检测到 ${failoverReason} 错误，立即触发故障转移`, { 
            error: error.message, 
            provider: 'cloudflare' 
        }, ctx);
        return true;
    }

    // 其他错误仍走连续失败逻辑
    failureCount++;
    if (failureCount >= MAX_FAILURES) {
        failoverReason = 'other';
        lastFailureTime = Date.now();
        logger.warn(`Cloudflare KV 连续失败，触发故障转移`, { failureCount, provider: 'cloudflare' }, ctx);
        return true;
    }

    return false;
}

/**
 * 执行故障转移
 */
function failover(env, ctx) {
    if (currentProvider === 'cloudflare' && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
        currentProvider = 'upstash';
        failureCount = 0;
        logger.info('故障转移完成', { from: 'cloudflare', to: 'upstash' }, ctx);
        return true;
    }
    return false;
}

/**
 * 获取当前使用的提供商名称
 */
function getCurrentProvider() {
    return currentProvider === 'upstash' ? 'Upstash Redis' : 'Cloudflare KV';
}

/**
 * 判断是否为可重试的网络/配额错误
 */
function isRetryableError(error) {
    const msg = (error.message || "").toLowerCase();
    return msg.includes('free usage limit') ||
           msg.includes('quota exceeded') ||
           msg.includes('rate limit') ||
           msg.includes('fetch failed') ||
           msg.includes('network') ||
           msg.includes('timeout');
}

/**
 * Upstash KV list 实现
 */
async function upstash_list(env, options = {}) {
    const url = `${env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(options.prefix || '')}*`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        },
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Upstash List Error: ${response.status} ${response.statusText}. Response: ${responseText.substring(0, 100)}`);
    }

    const responseText = await response.text();
    const result = safeJsonParse(responseText, 'upstash_list');
    if (!result) {
        throw new Error(`Upstash List Parse Error: Failed to parse response. Response: ${responseText.substring(0, 100)}`);
    }

    if (result.error) {
        throw new Error(`Upstash List Error: ${result.error}`);
    }

    return {
        keys: result.result.map(key => ({ name: key }))
    };
}

/**
 * Upstash KV get 实现
 */
async function upstash_get(env, key, options = {}) {
    const url = `${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        },
    });

    if (!response.ok) {
        if (response.status === 404) return null;
        const responseText = await response.text();
        throw new Error(`Upstash Get Error: ${response.status} ${response.statusText}. Response: ${responseText.substring(0, 100)}`);
    }

    const responseText = await response.text();
    const result = safeJsonParse(responseText, 'upstash_get');
    if (!result) {
        throw new Error(`Upstash Get Parse Error: Failed to parse response. Response: ${responseText.substring(0, 100)}`);
    }

    if (result.error) {
        throw new Error(`Upstash Get Error: ${result.error}`);
    }

    const value = result.result;
    if (value === null || value === undefined) return null;

    const type = options.type || 'json';
    if (type === 'json') {
        // 如果值已经是对象，直接返回
        if (typeof value === 'object') return value;
        // 如果是字符串，尝试JSON解析
        return safeJsonParse(value, `upstash_get value for key ${key}`) || value;
    }
    return value;
}

/**
 * Upstash KV put 实现
 */
async function upstash_put(env, key, value) {
    const valueStr = typeof value === "string" ? value : JSON.stringify(value);
    const command = ["SET", key, valueStr];

    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Upstash Put Error: ${response.status} ${response.statusText}. Response: ${responseText.substring(0, 100)}`);
    }

    const responseText = await response.text();
    const result = safeJsonParse(responseText, 'upstash_put');
    if (!result) {
        throw new Error(`Upstash Put Parse Error: Failed to parse response. Response: ${responseText.substring(0, 100)}`);
    }

    if (result.error) {
        throw new Error(`Upstash Put Error: ${result.error}`);
    }

    return result.result === "OK";
}

/**
 * Upstash KV mget 批量获取实现
 */
async function upstash_mget(env, keys) {
    if (keys.length === 0) return [];

    const body = JSON.stringify({ keys });

    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/mget`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: body,
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Upstash MGET Error: ${response.status} ${response.statusText}. Response: ${responseText.substring(0, 100)}`);
    }

    const responseText = await response.text();
    const result = safeJsonParse(responseText, 'upstash_mget');
    if (!result) {
        throw new Error(`Upstash MGET Parse Error: Failed to parse response. Response: ${responseText.substring(0, 100)}`);
    }

    if (result.error) {
        throw new Error(`Upstash MGET Error: ${result.error}`);
    }

    return result.result || [];
}

/**
 * 带故障转移的KV操作执行器
 */
async function executeWithFailover(operation, env, ctx, ...args) {
    // 1. 检查是否可以恢复
    checkRecovery(ctx);

    let attempts = 0;
    const maxAttempts = 2; // 降级模式下减少重试次数

    while (attempts < maxAttempts) {
        try {
            logger.debug('尝试访问存储源', { provider: getCurrentProvider(), operation }, ctx);
            if (currentProvider === 'upstash') {
                const upstashOp = operation.replace('_kv_', 'upstash_');
                if (upstashOp === 'upstash_list') return await upstash_list(env, ...args);
                if (upstashOp === 'upstash_get') return await upstash_get(env, ...args);
                if (upstashOp === 'upstash_put') return await upstash_put(env, ...args);
                throw new Error(`Unknown Upstash operation: ${upstashOp}`);
            } else {
                const kv = env.KV_STORAGE;
                const kvOp = operation.replace('_kv_', '');
                return await kv[kvOp](...args);
            }
        } catch (error) {
            attempts++;

            if (shouldFailover(error, env, ctx)) {
                failover(env, ctx);
                // 切换后立即重试
                continue;
            }

            if (attempts >= maxAttempts || currentProvider === 'upstash') {
                throw error;
            }
            
            console.log(`ℹ️ ${getCurrentProvider()} 重试中 (${attempts}/${maxAttempts})...`);
        }
    }
}

/**
 * Base64URL 编码辅助函数
 */
function base64UrlEncode(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

/**
 * 验证QStash签名 (手动实现)
 */
async function verifyQStashSignature(request, env, skipBodyRead = false, ctx = null) {
  console.log('=== QStash Signature Debug Start ===');
  const headersLog = Object.fromEntries(request.headers.entries());
  console.log('All request headers:', headersLog);
  const signature = request.headers.get('Upstash-Signature');
  const timestamp = request.headers.get('Upstash-Timestamp');

  console.log('Raw signature:', signature);
  console.log('Raw timestamp:', timestamp);

  let body;

  if (!signature || !timestamp) {
    if (skipBodyRead) {
      console.log('=== QStash Signature Skipped (no headers) ===');
      return null;
    }
    if (env.SKIP_SIGNATURE_VERIFY === 'true') {
      body = await request.arrayBuffer();
      console.log('Request body length:', body.byteLength);
      console.log('=== QStash Signature Verified OK (skipped) ===');
      return new Uint8Array(body);
    }
    const error = new Error('Missing Upstash-Signature or Upstash-Timestamp header');
    Object.assign(error, { status: 401 });
    throw error;
  }

    // 有签名头，读取 body 并验证
    body = await request.arrayBuffer();
    const bodyUint8 = new Uint8Array(body);
    console.log('Request body length:', body.byteLength);

    // 2. 验证时间戳是否过期
    const now = Math.floor(Date.now() / 1000);
    let ts = parseInt(timestamp);
  
    // 兼容毫秒级时间戳 (如果 ts > 10^12，通常是毫秒)
    console.log('Parsed timestamp (s):', ts);
    if (ts > 1000000000000) {
        ts = Math.floor(ts / 1000);
    }

    const window = parseInt(env.SIGNATURE_EXPIRATION_WINDOW) || 900; // 默认 15 分钟
    const timeDiff = Math.abs(now - ts);
    console.log('Current time (s):', now, 'Time diff (s):', timeDiff, 'Allowed window (s):', window);
    if (timeDiff > window) {
        const error = new Error(`Signature expired (now: ${now}, ts: ${ts}, window: ${window})`);
        Object.assign(error, { status: 401 });
        throw error;
    }

    // QStash签名格式: timestamp.body
    // 使用 Uint8Array 拼接以保证多字节字符一致性
    const encoder = new TextEncoder();
    const timestampBytes = encoder.encode(`${timestamp}.`);
    const message = new Uint8Array(timestampBytes.length + bodyUint8.length);
    message.set(timestampBytes);
    message.set(bodyUint8, timestampBytes.length);

    if (!env.QSTASH_CURRENT_SIGNING_KEY) {
      logger.error('缺少 QSTASH_CURRENT_SIGNING_KEY', {}, ctx);
      if (env.SKIP_SIGNATURE_VERIFY === 'true') {
        logger.info('SKIP_SIGNATURE_VERIFY=true，跳过签名验证', {}, ctx);
        return bodyUint8;
      }
      const error = new Error('QSTASH_CURRENT_SIGNING_KEY 未设置，无法验证签名');
      Object.assign(error, { status: 500 });
      throw error;
    }

    // 计算预期签名
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.QSTASH_CURRENT_SIGNING_KEY),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const expectedSignature = await crypto.subtle.sign('HMAC', key, message);
    const expectedBase64 = base64UrlEncode(expectedSignature);

    // 比较签名 (QStash使用 v1a=base64url 格式)
    const providedSignature = signature.replace('v1a=', '').replace(/=/g, '');
    if (providedSignature !== expectedBase64) {
        logger.debug('签名验证失败详情', {
            expectedSignature: expectedBase64,
            providedSignature: providedSignature,
            bodyLength: bodyUint8.length
        }, ctx);
        const error = new Error('Signature verification failed');
        Object.assign(error, { status: 401 });
        throw error;
    }

    return bodyUint8;
}

/**
 * 解析实例数据，支持多种格式
 */
function parseInstanceData(rawData, key) {
    if (!rawData) return null;

    // 如果已经是对象（测试环境），直接返回
    if (typeof rawData === 'object') {
        return rawData;
    }

    // 优先使用 safeJsonParse，支持自动修复无引号键
    let parsed = safeJsonParse(rawData, `parseInstanceData for key ${key}`);
    if (parsed !== null) {
        // 如果解析结果是字符串且看起来像 JSON，尝试再次解析
        if (typeof parsed === 'string' && (parsed.trim().startsWith('{') || parsed.trim().startsWith('['))) {
            const doubleParsed = safeJsonParse(parsed, `double parse for key ${key}`);
            if (doubleParsed !== null) {
                parsed = doubleParsed;
            }
        }
        return parsed;
    }

    // 如果 safeJsonParse 失败，尝试手动解析对象字面量格式 {key:value,key:value}
    try {
        // 移除外层花括号，分割键值对
        const content = rawData.trim();
        if (content.startsWith('{') && content.endsWith('}')) {
            const pairs = content.slice(1, -1).split(',');
            const obj = {};
            for (const pair of pairs) {
                const [keyPart, ...valueParts] = pair.split(':');
                const value = valueParts.join(':'); // 处理值中可能包含冒号的情况
                const cleanKey = keyPart.trim();
                const cleanValue = value.trim();

                // 尝试转换数值类型
                if (!isNaN(cleanValue) && cleanValue !== '') {
                    obj[cleanKey] = parseFloat(cleanValue);
                } else if (cleanValue === 'true') {
                    obj[cleanKey] = true;
                } else if (cleanValue === 'false') {
                    obj[cleanKey] = false;
                } else {
                    // 移除可能的引号
                    obj[cleanKey] = cleanValue.replace(/^["']|["']$/g, '');
                }
            }
            return obj;
        }
    } catch (parseError) {
        logger.warn('手动解析实例数据失败，记录完整原始数据', { key, rawData, error: parseError.message });
    }

    // 所有解析方法都失败
    logger.warn('实例数据解析失败，记录完整原始数据', { key, rawData });
    return null;
}

/**
 * 获取活跃实例列表
 */
async function getActiveInstances(env, ctx) {
    try {
        const activeInstances = [];
        const now = Date.now();

        // 1. 获取所有实例键
        const keysResult = await executeWithFailover('_kv_list', env, ctx, { prefix: INSTANCE_PREFIX });
        const keys = keysResult.keys.map(k => k.name);
        logger.debug('获取到实例键列表', { keys }, ctx);

        if (keys.length === 0) return [];

        // 2. 批量获取数据
        let rawDatas;
        if (currentProvider === 'upstash') {
            rawDatas = await upstash_mget(env, keys);
        } else {
            rawDatas = await Promise.all(
                keys.map(key => executeWithFailover('_kv_get', env, ctx, key))
            );
        }

        console.log(`[DEBUG] 获取到 ${keys.length} 个实例键 (provider: ${getCurrentProvider()})`);
        console.log('[DEBUG] 实例键列表:', keys);
        const allInstancesData = keys.map((key, i) => ({
            key,
            rawData: rawDatas[i],
            parsed: parseInstanceData(rawDatas[i], key)
        }));
        console.log('[DEBUG] 所有实例详细信息:');
        console.log(JSON.stringify(allInstancesData, null, 2));

        // 3. 解析并过滤
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const rawData = rawDatas[i];
            try {
                logger.debug('获取到实例原始数据', { key, rawData }, ctx);
                const instance = parseInstanceData(rawData, key);
                logger.debug('实例数据解析成功', { key, parsedInstance: instance }, ctx);
                if (!instance || typeof instance !== 'object') {
                    logger.warn('实例数据为空、格式错误或不是对象', { key, rawData, instanceType: typeof instance, provider: getCurrentProvider() }, ctx);
                    continue;
                }
                if (instance.status !== 'active') {
                    logger.warn('跳过实例: 状态非活跃', { id: instance.id, status: instance.status, reason: 'inactive_status' }, ctx);
                    continue;
                }
                if (!instance.lastHeartbeat) {
                    logger.warn('跳过实例: 缺少心跳时间戳', { id: instance.id, reason: 'missing_heartbeat' }, ctx);
                    continue;
                }
                const timeDiff = now - instance.lastHeartbeat;
                if (timeDiff >= HEARTBEAT_TIMEOUT) {
                    logger.warn('跳过实例: 心跳过期', { id: instance.id, diff: timeDiff, timeout: HEARTBEAT_TIMEOUT, lastHeartbeat: new Date(instance.lastHeartbeat).toISOString(), reason: 'heartbeat_expired' }, ctx);
                    continue;
                }
                if (!instance.url) {
                    logger.warn('跳过实例: 缺少URL', { id: instance.id, reason: 'missing_url' }, ctx);
                    continue;
                }
                activeInstances.push(instance);
            } catch (e) {
                logger.error('实例信息获取失败', { instance: key, error: e.message, provider: getCurrentProvider() }, ctx);
            }
        }

        if (activeInstances.length === 0) {
            logger.warn('未找到活跃实例', { nodeEnv: env.NODE_ENV, provider: getCurrentProvider(), suggestion: (env.NODE_ENV === 'development') ? '尝试使用 --remote 参数访问生产 KV 数据' : '请检查实例注册和心跳' }, ctx);
        }

        return activeInstances;
    } catch (error) {
        logger.error('活跃实例列表获取失败', { error: error.message, provider: getCurrentProvider(), failureCount, lastFailureTime: new Date(lastFailureTime).toISOString() }, ctx);
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

    // 获取当前索引
    let currentIndex = 0;
    try {
        const stored = await executeWithFailover('_kv_get', env, ctx, ROUND_ROBIN_KEY);
        currentIndex = stored ? parseInt(stored) : 0;
    } catch (e) {
        logger.error('轮询索引获取失败', { error: e.message }, ctx);
    }

    // 选择实例
    const targetIndex = currentIndex % instances.length;
    const targetInstance = instances[targetIndex];

    // 更新索引
    try {
        await executeWithFailover('_kv_put', env, ctx, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
    } catch (e) {
        logger.error('轮询索引更新失败', { error: e.message }, ctx);
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

    // 确保 Host 头部反映目标实例
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
        if (originalBody instanceof Uint8Array || originalBody instanceof ArrayBuffer) {
            const length = originalBody instanceof Uint8Array ? originalBody.length : originalBody.byteLength;
            logger.debug('转发请求 body', { length, hexPreview: Array.from(new Uint8Array(originalBody).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('') }, ctx);
        } else {
            logger.debug('转发请求 body (非字节流)', { length: originalBody?.length }, ctx);
        }
    }

    const forwardRequest = new Request(url.toString(), requestOptions);

    const response = await fetch(forwardRequest);

    // 记录5xx错误但不抛出
    if (response.status >= 500) {
        logger.warn('后端返回 5xx 错误', { status: response.status, instanceId: instance.id }, ctx);
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
            if (response.status >= 500) {
                // 如果后端返回 5xx，保存它并尝试下一个实例
                last5xxResponse = response;
                continue;
            }
            // 2xx, 3xx, 4xx 响应直接返回
            return response;
        } catch (error) {
            logger.error('转发请求失败', { instanceId: instance.id, error: error.message }, ctx);
            lastError = error;
            // 网络层面的错误，继续尝试下一个实例
        }
    }

    // 如果所有实例都尝试过了
    // 1. 如果有后端返回的 5xx 响应，透传它
    if (last5xxResponse) {
        logger.warn('所有实例均返回 5xx，透传最后一个响应', { status: last5xxResponse.status }, ctx);
        return last5xxResponse;
    }

    // 2. 如果是网络连接等导致的异常，抛出
    throw lastError || new Error('All instances failed');
}

// 导出函数以便测试
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
    logger
};

// 导出状态访问器以便测试
export const getCurrentProviderState = () => ({ currentProvider, failureCount, lastFailureTime, failoverReason });
export const setCurrentProviderState = (state) => {
    if (state.currentProvider !== undefined) currentProvider = state.currentProvider;
    if (state.failureCount !== undefined) failureCount = state.failureCount;
    if (state.lastFailureTime !== undefined) lastFailureTime = state.lastFailureTime;
    if (state.failoverReason !== undefined) failoverReason = state.failoverReason;
};

/**
 * Worker 主入口
 */
const handler = {
    async fetch(request, env, ctx) {
        // 规范化请求 URL：将多个连续斜杠替换为单个斜杠
        const normalizedUrl = new URL(request.url);
        normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

        // 环境变量校验
        if (!env.AXIOM_TOKEN) {
            console.warn('AXIOM_TOKEN 未设置，日志功能将被禁用');
        }
        if (!env.QSTASH_CURRENT_SIGNING_KEY && env.SKIP_SIGNATURE_VERIFY !== 'true') {
            console.warn('QSTASH_CURRENT_SIGNING_KEY 未设置且未跳过签名验证，Webhook 请求将被拒绝');
        }
        if (env.CF_KV_NAMESPACE_ID && !env.KV_STORAGE) {
            console.warn('CF_KV_NAMESPACE_ID 已设置但 KV_STORAGE 绑定缺失，KV 功能将被禁用');
        }
        if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
            console.warn('UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN 未设置，故障转移功能将被禁用');
        }

        // 初始化日志配置
        logger.configure({
            env: env.NODE_ENV || 'production'
        });
        logger.info('环境初始化', { nodeEnv: env.NODE_ENV || 'production', hasKv: !!env.KV_STORAGE }, ctx);

        // 可选：设置 Worker ID
        // Cloudflare Workers 不支持 global 对象，此处逻辑仅在测试环境有效
        if (typeof globalThis !== 'undefined') {
            globalThis.WORKER_ID = 'qstash-lb';
        }

        try {
            // 检查健康检查路径
            if ((request.method === 'GET' || request.method === 'HEAD') && normalizedUrl.pathname === '/health') {
                return new Response('LB is running', { status: 200 });
            }

            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204 });
            }

            // 1. 验证QStash签名
            let body = null;
            if (request.method === 'GET' || request.method === 'HEAD') {
                body = await verifyQStashSignature(request, env, true, ctx);
            } else {
                body = await verifyQStashSignature(request, env, false, ctx);
            }
            if (body === null) body = new Uint8Array();

            // 2. 获取活跃实例
            const activeInstances = await getActiveInstances(env, ctx);
            logger.info('活跃实例查询完成', { count: activeInstances.length }, ctx);

            if (activeInstances.length === 0) {
                return new Response('No active instances available', { status: 503 });
            }

            // 3. 选择目标实例 (轮询)
            const targetInstance = await selectTargetInstance(activeInstances, env, ctx);
            if (!targetInstance) {
                return new Response('No target instance selected', { status: 503 });
            }

            logger.info('开始转发请求', { instanceId: targetInstance.id, url: targetInstance.url }, ctx);

            // 4. 转发请求
            const response = await fetchWithRetry([targetInstance, ...activeInstances.filter(i => i !== targetInstance)], normalizedUrl, request, env, body, ctx);

            // 5. 更新轮询索引 (可选，简化版本不更新)
            // 这里可以存储到KV，但为了简化，使用环境变量或简单计数

            logger.debug('负载均衡请求完成', { status: response.status }, ctx);

            return response;

        } catch (error) {
            const status = error.status || 500;
            if (status === 401) {
                logger.warn('签名验证失败', { error: error.message }, ctx);
            } else {
                logger.error('负载均衡器错误', { error: error.message, stack: error.stack }, ctx);
            }
            return new Response(JSON.stringify({
              error: error.message,
              timestamp: new Date().toISOString()
            }), {
              status,
              headers: { 'Content-Type': 'application/json' }
            });
        }
    }
};


// @ts-expect-error Dynamic config function is supported by the library at runtime despite TypeScript complaints
export default instrument(handler, (env) => {
    // 基础配置
    const baseConfig = { serviceName: 'lb-worker-js' };
    
    // 如果缺少必要变量，返回不带 exporter 的完整合法对象
    if (!env?.AXIOM_TOKEN || !env?.AXIOM_DATASET) {
        console.warn('OTEL: Missing AXIOM_TOKEN or AXIOM_DATASET');
        return baseConfig;
    }
    
    // 返回包含 exporter 的配置
    return {
        serviceName: 'lb-worker-js',
        exporter: {
            url: 'https://api.axiom.co/v1/traces',
            // 确保 headers 始终是一个对象
            headers: {
                Authorization: `Bearer ${env.AXIOM_TOKEN}`,
                'X-Axiom-Dataset': env.AXIOM_DATASET,
            },
        },
    };
});