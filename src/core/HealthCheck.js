/**
 * 健康检查模块
 * 处理 Redis 健康检查逻辑
 */

import { logger } from '../logger.js';
import { _getInitializedCacheService } from '../legacy/redisCompat.js';

/**
 * 检查 Redis 健康状况 (使用 CACHE_PROVIDERS)
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Function} executor - 执行器函数
 * @returns {Promise<boolean>} 健康状态
 */
async function checkRedisHealth(env, ctx, executor = null) {
  // 在测试环境中，如果没有 logger，使用 mock logger 避免错误
  const checkRedisHealthLogger = (typeof logger !== 'undefined' && logger.child) ? logger.child({ module: 'checkRedisHealth' }) : {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {}
  };

  if (!env.CACHE_PROVIDERS) {
    await checkRedisHealthLogger.warn('CACHE_PROVIDERS not configured', {});
    return false;
  }

  try {
    const service = await _getInitializedCacheService(env, ctx, checkRedisHealthLogger);

    if (service.primaryProvider) {
      const provider = service.getCurrentProvider();
      const start = Date.now();
      try {
        if (service.primaryProvider.ping) {
          await service.primaryProvider.ping();
        } else {
          await service.get('healthcheck_ping', 'string', {}, ctx);
        }
        const duration = Date.now() - start;
        await checkRedisHealthLogger.info(`Redis 健康检查成功 (CacheService, provider=${provider})`, { duration: `${duration}ms`, provider });
        return true;
      } catch (pingError) {
        await checkRedisHealthLogger.warn(`CacheService Redis PING 健康检查失败: ${pingError.message}`, { provider });
      }
    }

    await checkRedisHealthLogger.error(`所有 provider 健康检查失败`, {});
    return false;
  } catch (e) {
    await checkRedisHealthLogger.error(`健康检查异常`, { error: e.message });
    return false;
  }
}

export {
  checkRedisHealth
};