/**
 * 请求处理器模块
 * 协调认证、负载均衡和代理逻辑
 */

import { logger, configureBaseLoggerTransport, isTestEnvironment, VERSION, flushLogs, updateVersionFromEnv, flushGlobalLoggerBuffer } from './logger.js';
import { trace } from '@opentelemetry/api';

// 导入新模块
import { verifyAdminToken } from './auth/admin.js';
import { verifyQStashSignature } from './auth/qstash.js';
import { getActiveInstances, scanLockKeys } from './core/InstanceManager.js';
import { selectInstanceByLock, selectInstanceByTemporaryLock, selectTargetInstance } from './core/LoadBalancerStrategy.js';
import { fetchWithRetry } from './core/ProxyService.js';
import { checkRedisHealth } from './core/HealthCheck.js';
import { normalizePath } from './routing/pathUtils.js';
import { normalizeEnvName, detectCacheProvider, getProviderPriority } from './utils/env.js';

// 导入状态管理模块
import { LoadBalancerState, createLoadBalancerState } from './state/LoadBalancerState.js';
import { getCurrentProvider, failover, shouldTriggerFailover, getCurrentProviderState } from './legacy/globalState.js';

// 导入缓存服务
import { CacheService } from './cache/CacheService.js';

// 向后兼容的全局状态访问器
let globalStateInstance = null;

/**
 * 获取或创建缓存服务实例
 */
async function _getInitializedCacheService(env, ctx, log) {
  if (!globalStateInstance) {
    globalStateInstance = createLoadBalancerState(env, logger);
    await globalStateInstance.initialize(new CacheService({ env, logger: log }));
  }
  return globalStateInstance;
}

/**
 * 处理健康检查请求
 */
async function handleHealthCheck(request, env, ctx, log, normalizedUrl) {
  try {
    const activeInstances = await getActiveInstances(env, ctx, log);
    const activeCount = activeInstances.length;
    const provider = await getCurrentProvider();
    const lockCount = await scanLockKeys(env, ctx, log);
    
    // 健康检查日志采样：仅在非生产环境或特定条件下记录详细信息
    const runtimeEnv = normalizeEnvName(env.NODE_ENV || 'prod');
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

/**
 * 处理实例查询请求
 */
async function handleInstanceQuery(request, env, ctx, log) {
  try {
    // 验证管理员Token
    await verifyAdminToken(request, env, ctx, log);
    
    const activeInstances = await getActiveInstances(env, ctx, log);
    const provider = await getCurrentProvider();
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

/**
 * 处理负载均衡请求
 */
async function handleLoadBalancing(request, env, ctx, log, normalizedUrl, body) {
  // 获取活跃实例
  const activeInstances = await getActiveInstances(env, ctx, log);
  await log.success('Active instances retrieved', { 
    count: activeInstances.length, 
    category: 'lb' 
  });

  if (activeInstances.length === 0) {
    const qstashMsgId = request.headers.get('Upstash-Message-Id');
    const retryCount = request.headers.get('Upstash-Retries');

    await log.warn('无活跃实例可用', {
      qstashMsgId,
      retryCount,
      path: normalizedUrl.pathname
    });

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

  // 选择目标实例：支持多种调度策略
  let targetInstance = null;
  let selectedStrategy = 'round-robin';

  if (normalizedUrl.pathname === '/api/tasks/download') {
    targetInstance = await selectInstanceByLock(activeInstances, env, ctx, log);
    selectedStrategy = 'lock-based';
  }

  if (!targetInstance && (normalizedUrl.pathname === '/api/tasks/upload' || normalizedUrl.pathname === '/api/tasks/batch')) {
    targetInstance = await selectInstanceByTemporaryLock(activeInstances, env, ctx, request, log);
    selectedStrategy = 'temporary-lock';
  }

  if (!targetInstance) {
    targetInstance = await selectTargetInstance(activeInstances, env, ctx, log);
    selectedStrategy = 'round-robin';
  }
  
  await log.info('Target instance selected', { 
    id: targetInstance?.id || 'NONE', 
    strategy: selectedStrategy,
    path: normalizedUrl.pathname,
    category: 'lb' 
  });
  
  if (!targetInstance) {
    await log.error('No target instance selected', { category: 'lb' });
    return new Response('No target instance selected', { status: 503 });
  }

  // 转发请求
  const response = await fetchWithRetry([targetInstance, ...activeInstances.filter(i => i !== targetInstance)], normalizedUrl, request, env, body, ctx, log);

  await log.debug('Load balancing request completed', { status: response.status, category: 'network' });

  await log.success('Request forwarded successfully', {
    finalStatus: response.status,
    instanceId: targetInstance.id,
    path: normalizedUrl.pathname,
    category: 'network'
  });

  return response;
}

/**
 * 主请求处理器
 */
async function handleRequest(request, env, ctx) {
  const requestId = ctx?._axiomDebugRequestId || 'unknown';
  console.log(`[AXIOM_DEBUG] ${requestId}: handleRequest started`);

  // Ensure logger transport is configured even when handleRequest is called directly.
  configureBaseLoggerTransport(env);

  // 初始化基础状态 - 必须在创建 requestLogger 之前执行
  const runtimeEnv = normalizeEnvName(env.NODE_ENV || 'prod');
  logger.configure({ env: runtimeEnv });

  const requestLogBuffer = []; // 为每个请求创建独立的日志缓冲
  if (ctx && ctx.logBuffer === undefined) {
    ctx.logBuffer = requestLogBuffer;
  }
  const requestLogger = logger.child({ module: 'handleRequest', logBuffer: requestLogBuffer });

  // 1. 在上下文还在时，显式捕获顶级 Span
  const rootSpan = trace.getActiveSpan();

  // 创建封装的 log 助手（包含 child 方法代理，防止调用 .child() 时崩溃）
  const log = {
    info: (message, data = {}) => requestLogger.info(message, data, rootSpan, ctx),
    warn: (message, data = {}) => requestLogger.warn(message, data, rootSpan, ctx),
    error: (message, data = {}) => requestLogger.error(message, data, rootSpan, ctx),
    debug: (message, data = {}) => requestLogger.debug(message, data, rootSpan, ctx),
    success: (message, data = {}) => requestLogger.success(message, data, rootSpan, ctx),
    child: (bindings) => requestLogger.child(bindings)
  };

  // 初始化全局状态
  try {
    if (!globalStateInstance) {
      const cacheServiceInstance = await _getInitializedCacheService(env, ctx, log);
      await log.debug('Global state initialized', { stateKey: 'lb:provider_state' });
    }
  } catch (stateError) {
    await log.warn('Failed to initialize global state, falling back to legacy variables', { error: stateError.message });
  }

  log.debug('Request Received', { method: request.method, url: request.url });

  // CORS preflight 优先处理
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

  // 提取请求来源信息
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

  // 路径规范化
  const normalizedUrl = new URL(request.url);
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');
  const originalPath = normalizedUrl.pathname;
  normalizedUrl.pathname = normalizePath(normalizedUrl.pathname);

  // 记录路径映射（如果发生映射）
  if (originalPath !== normalizedUrl.pathname) {
    await log.info('Path normalized', {
      original: originalPath,
      normalized: normalizedUrl.pathname,
      category: 'network'
    });
  }

  // 简洁的启动日志
  await log.info('Load balancer request started', {
    path: normalizedUrl.pathname,
    method: request.method,
    rayId: request.headers.get('cf-ray'),
    version: VERSION,
    category: 'start'
  });

  // 诊断信息
  const primaryProvider = detectCacheProvider(env);
  const priorities = getProviderPriority(env);
  
  await log.info('Cache provider status', {
    primary: primaryProvider,
    priorities: priorities,
    hasKv: !!env.KV_STORAGE,
    hasUpstash: !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
    envOverride: env.CACHE_PROVIDERS || 'none',
    category: 'config'
  });

  // 健康检查
  if ((request.method === 'GET' || request.method === 'HEAD') && normalizedUrl.pathname === '/health') {
    return await handleHealthCheck(request, env, ctx, log, normalizedUrl);
  }

  // 实例查询接口
  if (request.method === 'GET' && normalizedUrl.pathname === '/api/instances') {
    return await handleInstanceQuery(request, env, ctx, log);
  }

  // 验证签名
  let body = null;
  try {
    body = await verifyQStashSignature(request, env, ctx, log);
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
    
    const statusCode = error.status === 413 ? 413 : 401;
    const errorLabel = statusCode === 413 ? 'Payload too large' : 'Signature verification failed';

    return new Response(JSON.stringify({
      error: errorLabel,
      message: error.message,
      timestamp: new Date().toISOString(),
      qstashMsgId,
      retryCount
    }), {
      status: statusCode,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  let result;
  try {
    console.log(`[AXIOM_DEBUG] ${requestId}: Before getActiveInstances, buffer size=${requestLogBuffer.length}`);
    
    result = await handleLoadBalancing(request, env, ctx, log, normalizedUrl, body);
    
    console.log(`[AXIOM_DEBUG] ${requestId}: After load balancing, buffer size=${requestLogBuffer.length}`);
  } catch (error) {
    await log.error('handleRequest 处理失败', { error: error.message });
    
    // 检查是否需要故障转移
    if (shouldTriggerFailover(error, env)) {
      await failover(env, ctx, log);
    }
    
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

    // 刷新全局 logger buffer
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

export {
  handleRequest
};
