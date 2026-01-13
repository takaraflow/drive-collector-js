/**
 * Cloudflare Workers Load Balancer - Main Entry Point
 * 
 * 重构后的模块化架构：
 * - auth/          认证模块
 * - core/          核心业务逻辑
 * - legacy/        向后兼容层
 * - routing/       路由工具
 * - utils/         工具函数
 * - cache/         缓存服务
 * - state/         状态管理
 */

import { logger, configureBaseLoggerTransport, isTestEnvironment, VERSION, updateVersionFromEnv } from './logger.js';
import { instrument } from '@microlabs/otel-cf-workers';
import { createSafeEnv } from './utils/env.js';

// 导入新模块
import { handleRequest } from './handler.js';

// 导出认证模块（供测试使用）
export { verifyAdminToken } from './auth/admin.js';
export { verifyQStashSignature, validateQStashMessage } from './auth/qstash.js';

// 导出核心模块（供测试使用）
export { parseInstanceData, normalizeHeartbeat, normalizeEpochMillis } from './core/InstanceParser.js';
export { getActiveInstances, scanLockKeys } from './core/InstanceManager.js';
export { selectInstanceByLock, selectTargetInstance, selectTargetInstanceWithKVAtomic, selectTargetInstanceWithRetry } from './core/LoadBalancerStrategy.js';
export { forwardToInstance, fetchWithRetry } from './core/ProxyService.js';
export { checkRedisHealth } from './core/HealthCheck.js';

// 导出工具模块（供测试使用）
export { normalizePath, PATH_MAP } from './routing/pathUtils.js';
export { normalizeEnvName, createSafeEnv } from './utils/env.js';
export { safeJsonParse, enhancedSafeJsonParse, isString } from './utils/json.js';
export { createPayloadTooLargeError, validateContentLengthHeader, readRequestBodyWithLimit } from './utils/http.js';
export { detectCacheProvider, getProviderPriority } from './utils/env.js';

// 导出常量（供测试使用）
export {
  ROUND_ROBIN_KEY,
  HEARTBEAT_TIMEOUT,
  TELEGRAM_LOCK_KEY,
  MAX_JSON_SIZE,
  MAX_REQUEST_BODY_SIZE,
  ENV_ALIASES
} from './config/constants.js';

// 导出缓存服务（供测试使用）
export { CacheService, cacheService } from './cache/CacheService.js';

// 导出状态管理（供测试使用）
export { LoadBalancerState, createLoadBalancerState } from './state/LoadBalancerState.js';

// 导出兼容层（供测试使用）
export {
  executeWithFailover,
  executeWithPriorityFallback,
  executeRedis,
  executeRedisScan,
  executeUpstashScan,
  upstash_get,
  retryRedisCommand
} from './legacy/redisCompat.js';

// 导出测试专用的 CacheService 实例管理函数
export {
  __test_setCacheServiceInstance,
  __test_resetCacheService
} from './cache/CacheService.js';

export {
  getCurrentProvider,
  shouldFailover,
  incrementFailureCount,
  resetFailureCount,
  switchProvider,
  failover,
  isRetryableError,
  shouldTriggerFailover,
  getCurrentProviderState,
  setCurrentProviderState
} from './legacy/globalState.js';

// 导出 logger（供测试使用）
export { logger };

// 导出 handler（供测试使用）
export { handleRequest } from './handler.js';

// Worker 处理器
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
const createSafeEnvProxy = (env) => {
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
    const safeEnv = createSafeEnvProxy(env);

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