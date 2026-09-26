/**
 * 负载均衡策略模块
 * 处理实例选择和路由逻辑
 */

import { ROUND_ROBIN_KEY, TELEGRAM_LOCK_KEY, TEMPORARY_SCHEDULING, SUCCESS_MESSAGES, ERROR_MESSAGES } from '../config/constants.js';
import { logger } from '../logger/compat.js';
import { safeJsonParse } from '../utils/json.js';
import { executeWithFailover } from '../legacy/redisCompat.js';

/**
 * 解析临时锁值
 * @param {string|Object} lockValue - 锁值
 * @returns {Object|null} 解析后的锁对象
 */
function parseTemporaryLock(lockValue) {
  let parsed = lockValue;
  
  if (typeof lockValue === 'string') {
    try {
      parsed = JSON.parse(lockValue);
    } catch (error) {
      return { originInstanceId: lockValue };
    }
  } else if (lockValue && typeof lockValue === 'object' && lockValue.value !== undefined) {
    try {
      parsed = JSON.parse(lockValue.value);
    } catch (error) {
      parsed = lockValue;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const originInstanceId = 
    parsed.originInstanceId || 
    parsed.instanceId || 
    parsed.instanced || 
    parsed.ownerId || 
    parsed.owner || 
    parsed.id;

  if (!originInstanceId) {
    return null;
  }

  return {
    originInstanceId,
    timestamp: Number(parsed.timestamp || parsed.acquiredAt || parsed.acquired_at || 0),
    ttl: Number(parsed.ttl || parsed.expiresIn || TEMPORARY_SCHEDULING.LOCK_TTL_SECONDS)
  };
}

/**
 * 检查临时锁是否过期
 * @param {Object} parsedLock - 解析后的锁对象
 * @returns {boolean} 是否过期
 */
function isTemporaryLockExpired(parsedLock) {
  if (!parsedLock.timestamp || !parsedLock.ttl) {
    return false;
  }

  const expiresAt = parsedLock.timestamp + parsedLock.ttl * 1000;
  return Date.now() > expiresAt;
}

/**
 * 根据临时锁选择实例（用于上传和批量任务的来源保持）
 * @param {Array} instances - 实例数组
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} request - HTTP请求对象
 * @param {Object} requestLogger - 请求日志器
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @returns {Promise<Object|null>} 选中的实例或null
 */
async function selectInstanceByTemporaryLock(instances, env, ctx, request, requestLogger = null, cacheService) {
  const tempLockLogger = requestLogger || logger.child({ module: 'temporaryLock' });
  if (!instances || instances.length === 0) return null;

  const qstashMsgId = request.headers.get('Upstash-Message-Id');
  if (!qstashMsgId) {
    await tempLockLogger.debug(SUCCESS_MESSAGES.TEMP_SCHEDULING_NO_MESSAGE_ID, { 
      category: 'temporary-scheduling'
    });
    return null;
  }

  const tempLockKey = `${TEMPORARY_SCHEDULING.LOCK_PREFIX}${qstashMsgId}`;
  const startTime = Date.now();

  await tempLockLogger.info(SUCCESS_MESSAGES.TEMP_SCHEDULING_STARTED, {
    tempLockKey,
    qstashMsgId,
    instanceCount: instances.length,
    category: 'temporary-scheduling'
  });

  try {
    const lockValue = await executeWithFailover(cacheService, '_kv_get', env, ctx, tempLockLogger, tempLockKey);
    if (!lockValue) {
      await tempLockLogger.debug(SUCCESS_MESSAGES.TEMP_SCHEDULING_LOCK_FOUND, { 
        tempLockKey, 
        qstashMsgId,
        category: 'temporary-scheduling' 
      });
      return null;
    }

    const parsedLock = parseTemporaryLock(lockValue);
    if (!parsedLock || !parsedLock.originInstanceId) {
      await tempLockLogger.warn(ERROR_MESSAGES.TEMP_LOCK_INVALID, { 
        tempLockKey, 
        rawLock: typeof lockValue === 'string' ? lockValue.substring(0, 100) : String(lockValue),
        category: 'temporary-scheduling' 
      });
      return null;
    }

    if (isTemporaryLockExpired(parsedLock)) {
      await tempLockLogger.debug(SUCCESS_MESSAGES.TEMP_SCHEDULING_LOCK_EXPIRED, { 
        tempLockKey, 
        originInstanceId: parsedLock.originInstanceId,
        timestamp: parsedLock.timestamp,
        ttl: parsedLock.ttl,
        category: 'temporary-scheduling' 
      });
      return null;
    }

    const targetInstance = instances.find(inst => inst.id === parsedLock.originInstanceId);
    if (targetInstance) {
      await tempLockLogger.success(SUCCESS_MESSAGES.TEMP_SCHEDULING_SUCCESS, { 
        tempLockKey, 
        originInstanceId: parsedLock.originInstanceId,
        qstashMsgId,
        duration: Date.now() - startTime,
        category: 'temporary-scheduling' 
      });
      return targetInstance;
    }

    await tempLockLogger.warn(SUCCESS_MESSAGES.TEMP_SCHEDULING_ORIGIN_NOT_ACTIVE, { 
      tempLockKey, 
      originInstanceId: parsedLock.originInstanceId,
      activeInstanceIds: instances.map(i => i.id),
      category: 'temporary-scheduling' 
    });
    return null;

  } catch (error) {
    await tempLockLogger.warn(SUCCESS_MESSAGES.TEMP_SCHEDULING_FALLBACK, { 
      tempLockKey, 
      error: error.message,
      qstashMsgId,
      category: 'temporary-scheduling' 
    });
    return null;
  }
}

/**
 * 根据锁持有者选择实例（用于需要会话锁的下载任务）
 * @param {Array} instances - 实例数组
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @returns {Promise<Object|null>} 选中的实例或null
 */
async function selectInstanceByLock(instances, env, ctx, requestLogger = null, cacheService) {
  const lockRoutingLogger = requestLogger || logger.child({ module: 'lockRouting' });
  if (!instances || instances.length === 0) return null;

  let lockValue;
  try {
    lockValue = await executeWithFailover(cacheService, '_kv_get', env, ctx, lockRoutingLogger, TELEGRAM_LOCK_KEY);
  } catch (error) {
    await lockRoutingLogger.warn('Lock read failed, falling back to round-robin', { 
      lockKey: TELEGRAM_LOCK_KEY, 
      error: error.message,
      category: 'lb'
    });
    return null;
  }

  if (!lockValue) {
    await lockRoutingLogger.debug('No lock found or lock expired, falling back to round-robin', { 
      lockKey: TELEGRAM_LOCK_KEY,
      category: 'lb'
    });
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
    await lockRoutingLogger.debug('⚠️ 锁值缺失实例信息，回退轮询', { lockKey: TELEGRAM_LOCK_KEY });
    return null;
  }

  const ownerInstance = instances.find(inst => inst.id === lockOwnerId);
  if (ownerInstance) {
    await lockRoutingLogger.success('Using lock owner as target instance', { 
      lockKey: TELEGRAM_LOCK_KEY, 
      instanceId: lockOwnerId,
      category: 'lb'
    });
    return ownerInstance;
  }

  await lockRoutingLogger.warn('Lock owner not in active instances, falling back to round-robin', { 
    lockKey: TELEGRAM_LOCK_KEY, 
    instanceId: lockOwnerId,
    category: 'lb'
  });
  return null;
}

/**
 * 选择目标实例 (轮询)
 * @param {Array} instances - 实例数组
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @returns {Promise<Object|null>} 选中的实例或null
 */
async function selectTargetInstance(instances, env, ctx, requestLogger = null, cacheService) {
  const selectTargetInstanceLogger = requestLogger || logger.child({ module: 'selectTargetInstance' });
  if (instances.length === 0) {
    return null;
  }

  if (instances.length === 1) {
    return instances[0];
  }

  try {
    if (env.REDIS_URL || env.UPSTASH_REDIS_REST_URL) {
      // 使用Redis原子操作
      const result = await executeWithFailover(cacheService, 'EVAL', env, ctx, selectTargetInstanceLogger, `
        -- KEYS[1]: 轮询索引键
        -- ARGV[1]: 实例总数
        local current = redis.call('GET', KEYS[1])
        if not current then
          current = '0'
        end
        local currentIndex = tonumber(current)
        local targetIndex = currentIndex % tonumber(ARGV[1])
        local nextIndex = (currentIndex + 1) % tonumber(ARGV[1])
        redis.call('SET', KEYS[1], tostring(nextIndex))
        return targetIndex
      `, ROUND_ROBIN_KEY, instances.length.toString());
      
      return instances[parseInt(result)];
    } else {
      // 使用KV的条件更新操作
      return await selectTargetInstanceWithKVAtomic(instances, env, ctx, selectTargetInstanceLogger, cacheService);
    }
  } catch (error) {
    await selectTargetInstanceLogger.error('原子轮询操作失败，回退到普通模式', { error: error.message });
    // 回退到原有逻辑，但增加重试机制
    return await selectTargetInstanceWithRetry(instances, env, ctx, selectTargetInstanceLogger, cacheService);
  }
}

/**
 * KV原子操作实现
 * @param {Array} instances - 实例数组
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} logger - 日志器
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @returns {Promise<Object>} 选中的实例
 */
async function selectTargetInstanceWithKVAtomic(instances, env, ctx, logger, cacheService) {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 获取当前值和metadata
      const stored = await executeWithFailover(cacheService, '_kv_get', env, ctx, logger, ROUND_ROBIN_KEY);
      const currentIndex = stored ? parseInt(stored) : 0;
      const targetIndex = currentIndex % instances.length;
      
      // 尝试条件更新 (简化版本，KV可能不支持条件更新)
      await executeWithFailover(cacheService, '_kv_put', env, ctx, logger, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
      return instances[targetIndex];
      
    } catch (error) {
      await logger.error(`KV atomic operation failed, retry ${attempt + 1}/${maxRetries}`, { 
        error: error.message,
        category: 'lb'
      });
      
      if (attempt === maxRetries - 1) {
        // 最后一次重试失败，使用随机选择
        const randomIndex = Math.floor(Math.random() * instances.length);
        await logger.warn('All KV retries failed, using random selection', { 
          randomIndex, 
          lastError: error.message,
          category: 'lb'
        });
        return instances[randomIndex];
      }
      
      // CF Workers 优化：减少延迟上限，避免超出 CPU 限制
      // 最大延迟 10ms（原为 100ms）
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5));
    }
  }
}

/**
 * 带重试的备用方案
 * @param {Array} instances - 实例数组
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} logger - 日志器
 * @param {CacheService} cacheService - The per-request cache service instance.
 * @returns {Promise<Object>} 选中的实例
 */
async function selectTargetInstanceWithRetry(instances, env, ctx, logger, cacheService) {
  const maxRetries = 3;
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const stored = await executeWithFailover(cacheService, '_kv_get', env, ctx, logger, ROUND_ROBIN_KEY);
      const currentIndex = stored ? parseInt(stored) : 0;
      const targetIndex = currentIndex % instances.length;
      
      // CF Workers 优化：减少延迟上限
      // 最大延迟 10ms（原为 50ms）
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 3));
      }
      
      await executeWithFailover(cacheService, '_kv_put', env, ctx, logger, ROUND_ROBIN_KEY, (currentIndex + 1).toString());
      
      return instances[targetIndex];
    } catch (error) {
      lastError = error;
      // P1修复：限制错误消息长度，防止泄露敏感信息
      const safeErrorMessage = error.message.length > 200 
        ? error.message.substring(0, 200) + '...[TRUNCATED]' 
        : error.message;
      await logger.error(`轮询操作重试 ${attempt + 1}/${maxRetries} 失败`, { error: safeErrorMessage });
    }
  }
  
  // 所有重试失败，使用随机选择
  const randomIndex = Math.floor(Math.random() * instances.length);
  await logger.warn(`所有轮询重试失败，使用随机选择`, { randomIndex, lastError: lastError?.message });
  return instances[randomIndex];
}

export {
  selectInstanceByLock,
  selectInstanceByTemporaryLock,
  selectTargetInstance,
  selectTargetInstanceWithKVAtomic,
  selectTargetInstanceWithRetry
};
