/**
 * Cloudflare Worker - QStash Webhook Load Balancer
 * 负载均衡器，接收QStash Webhook，转发到活跃实例
 */

import { logger } from '../services/logger.js';

// 常量
const INSTANCE_PREFIX = 'instance:';
const HEARTBEAT_TIMEOUT = 15 * 60 * 1000; // 15分钟
const ROUND_ROBIN_KEY = 'lb:round_robin_index';

// 故障转移配置
let currentProvider = 'cloudflare'; // 'cloudflare' | 'upstash'
let failureCount = 0;
let lastFailureTime = 0;
const MAX_FAILURES = 3;

/**
 * 检查是否应该触发故障转移
 */
function shouldFailover(error, env) {
    if (currentProvider === 'upstash' || !env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
        return false;
    }

    const isQuotaError = error.message.includes('free usage limit') ||
                        error.message.includes('quota exceeded') ||
                        error.message.includes('rate limit') ||
                        error.message.includes('fetch failed') ||
                        error.message.includes('network') ||
                        error.message.includes('timeout');

    if (isQuotaError) {
        failureCount++;
        lastFailureTime = Date.now();
        if (failureCount >= MAX_FAILURES) {
            logger.warn(`Cloudflare KV 连续失败，触发故障转移`, { failureCount, provider: 'cloudflare' });
            return true;
        }
    }

    return false;
}

/**
 * 执行故障转移
 */
function failover(env) {
    if (currentProvider === 'cloudflare' && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
        currentProvider = 'upstash';
        failureCount = 0;
        logger.info('故障转移完成', { from: 'cloudflare', to: 'upstash' });
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
        throw new Error(`Upstash List Error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
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
        throw new Error(`Upstash Get Error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    if (result.error) {
        throw new Error(`Upstash Get Error: ${result.error}`);
    }

    const value = result.result;
    if (value === null || value === undefined) return null;

    const type = options.type || 'json';
    if (type === 'json') {
        try {
            return JSON.parse(value);
        } catch (e) {
            return value;
        }
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
        throw new Error(`Upstash Put Error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    if (result.error) {
        throw new Error(`Upstash Put Error: ${result.error}`);
    }

    return result.result === "OK";
}

/**
 * 带故障转移的KV操作执行器
 */
async function executeWithFailover(operation, env, ...args) {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
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

            if (!isRetryableError(error) || currentProvider === 'upstash') {
                throw error;
            }

            if (shouldFailover(error, env)) {
                failover(env);
                continue; // 重试一次，使用新提供商
            }

            if (attempts >= maxAttempts) throw error;
            console.log(`ℹ️ ${getCurrentProvider()} 重试中 (${attempts}/${maxAttempts})...`);
        }
    }
}

/**
 * 验证QStash签名 (手动实现)
 */
async function verifyQStashSignature(request, env) {
    const signature = request.headers.get('Upstash-Signature');
    const timestamp = request.headers.get('Upstash-Timestamp');
    const body = await request.text();

    if (!signature || !timestamp) {
        throw new Error('Missing Upstash-Signature or Upstash-Timestamp header');
    }

    // QStash签名格式: timestamp.body
    const message = `${timestamp}.${body}`;

    // 计算预期签名
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.QSTASH_CURRENT_SIGNING_KEY),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const expectedSignature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const expectedBase64 = btoa(String.fromCharCode(...new Uint8Array(expectedSignature)));

    // 比较签名 (QStash使用 v1a=base64 格式)
    const providedSignature = signature.replace('v1a=', '');
    if (providedSignature !== expectedBase64) {
        throw new Error('Signature verification failed');
    }

    return body;
}

/**
 * 获取活跃实例列表
 */
async function getActiveInstances(env) {
    try {
        const activeInstances = [];
        const now = Date.now();

        // 获取所有实例键
        const keys = await executeWithFailover('_kv_list', env, { prefix: INSTANCE_PREFIX });

        for (const key of keys.keys) {
            try {
                const instance = await executeWithFailover('_kv_get', env, key.name, { type: 'json' });
                if (instance &&
                    instance.status === 'active' &&
                    instance.lastHeartbeat &&
                    (now - instance.lastHeartbeat) < HEARTBEAT_TIMEOUT &&
                    instance.url) {
                    activeInstances.push(instance);
                }
            } catch (e) {
                // 忽略单个实例获取失败
                logger.error('实例信息获取失败', { instance: key.name, error: e.message });
            }
        }

        return activeInstances;
    } catch (error) {
        logger.error('活跃实例列表获取失败', { error: error.message });
        return [];
    }
}

/**
 * 选择目标实例 (轮询)
 */
async function selectTargetInstance(instances, env) {
    if (instances.length === 0) {
        return null;
    }

    // 获取当前索引
    let currentIndex = 0;
    try {
        const stored = await executeWithFailover('_kv_get', env, ROUND_ROBIN_KEY);
        currentIndex = stored ? parseInt(stored) : 0;
    } catch (e) {
        logger.error('轮询索引获取失败', { error: e.message });
    }

    // 选择实例
    const targetIndex = currentIndex % instances.length;
    const targetInstance = instances[targetIndex];

    // 更新索引
    try {
        await executeWithFailover('_kv_put', env, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
    } catch (e) {
        logger.error('轮询索引更新失败', { error: e.message });
    }

    return targetInstance;
}

/**
 * 转发请求到目标实例
 */
async function forwardToInstance(instance, request, originalBody) {
    const url = new URL(request.url);
    url.host = new URL(instance.url).host;
    url.protocol = new URL(instance.url).protocol;

    const forwardRequest = new Request(url.toString(), {
        method: request.method,
        headers: {
            ...Object.fromEntries(request.headers),
            'X-Forwarded-Host': request.headers.get('Host'),
            'X-Forwarded-Proto': url.protocol.replace(':', ''),
            'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || '',
            'X-Load-Balancer': 'qstash-lb'
        },
        body: originalBody
    });

    const response = await fetch(forwardRequest);

    // 如果是5xx错误，抛出异常以触发重试
    if (response.status >= 500) {
        throw new Error(`Instance ${instance.id} returned ${response.status}`);
    }

    return response;
}

/**
 * 带重试的转发逻辑
 */
async function fetchWithRetry(instances, request, env) {
    let lastError;

    for (const instance of instances) {
        try {
            const response = await forwardToInstance(instance, request, request.body);
            return response;
        } catch (error) {
            logger.error('转发请求失败', { instanceId: instance.id, error: error.message });
            lastError = error;
            // 继续尝试下一个实例
        }
    }

    // 所有实例都失败
    throw lastError || new Error('All instances failed');
}

// 导出函数以便测试
export {
    verifyQStashSignature,
    getActiveInstances,
    selectTargetInstance,
    forwardToInstance,
    fetchWithRetry,
    shouldFailover,
    failover,
    getCurrentProvider,
    isRetryableError,
    executeWithFailover
};

// 导出状态访问器以便测试
export const getCurrentProviderState = () => ({ currentProvider, failureCount, lastFailureTime });
export const setCurrentProviderState = (state) => {
    if (state.currentProvider !== undefined) currentProvider = state.currentProvider;
    if (state.failureCount !== undefined) failureCount = state.failureCount;
    if (state.lastFailureTime !== undefined) lastFailureTime = state.lastFailureTime;
};

/**
 * Worker 主入口
 */
export default {
    async fetch(request, env, ctx) {
        try {
            // 1. 验证QStash签名
            const body = await verifyQStashSignature(request, env);

            // 2. 获取活跃实例
            const activeInstances = await getActiveInstances(env);
            logger.info('活跃实例查询完成', { count: activeInstances.length });

            if (activeInstances.length === 0) {
                return new Response('No active instances available', { status: 503 });
            }

            // 3. 选择目标实例 (轮询)
            const targetInstance = await selectTargetInstance(activeInstances, env);
            if (!targetInstance) {
                return new Response('No target instance selected', { status: 503 });
            }

            logger.info('开始转发请求', { instanceId: targetInstance.id, url: targetInstance.url });

            // 4. 转发请求
            const response = await fetchWithRetry([targetInstance, ...activeInstances.filter(i => i !== targetInstance)], request, env);

            // 5. 更新轮询索引 (可选，简化版本不更新)
            // 这里可以存储到KV，但为了简化，使用环境变量或简单计数

            return response;

        } catch (error) {
            logger.error('负载均衡器错误', { error: error.message, stack: error.stack });
            return new Response(`Load Balancer Error: ${error.message}`, { status: 500 });
        }
    }
};