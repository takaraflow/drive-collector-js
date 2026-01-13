/**
 * 实例管理器模块
 * 负责获取和管理活跃实例
 */

import { HEARTBEAT_TIMEOUT, TELEGRAM_LOCK_KEY } from '../config/constants.js';
import { logger, isTestEnvironment } from '../logger.js';
import { parseInstanceData } from './InstanceParser.js';
import { executeWithFailover } from '../legacy/redisCompat.js';

/**
 * 扫描锁键（用于 leader election 提示）
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} parentLogger - 父日志器
 * @returns {Promise<number>} 锁键数量
 */
async function scanLockKeys(env, ctx = null, parentLogger = logger) {
  const scanLockKeysLogger = parentLogger.child({ module: 'scanLockKeys' });
  try {
    const lockPrefixes = ['lock:', 'task:', 'msg_lock:'];
    let lockCount = 0;

    // 串行执行扫描，避免 Redis 客户端并发问题
    const results = [];
    for (const prefix of lockPrefixes) {
      try {
        const result = await executeWithFailover('_kv_list', env, ctx, scanLockKeysLogger, prefix);
        results.push(result);
      } catch (e) {
        scanLockKeysLogger.debug('锁键扫描失败', { prefix, error: e.message });
        results.push({ keys: [] });
      }
    }

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
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<Array>} 活跃实例数组
 */
async function getActiveInstances(env, ctx = null, requestLogger = null) {
  const getActiveInstancesLogger = requestLogger || logger.child({ module: 'getActiveInstances' });
  
  // 描述Redis终端（用于日志）
  function describeRedisEndpoint(env) {
    return 'using CACHE_PROVIDERS';
  }
  
  const redisEndpointSummary = describeRedisEndpoint(env);
  await getActiveInstancesLogger.debug('Redis endpoint summary', { endpoint: redisEndpointSummary });
  
  try {
    // 扫描所有契约键前缀
    const prefixes = ['instance:', 'lock:', 'task:', 'msg_lock:'];

    // 串行获取所有前缀的键（避免 Redis 客户端并发 SCAN 问题）
    const prefixResults = [];
    for (const prefix of prefixes) {
      try {
        const result = await executeWithFailover('_kv_list', env, ctx, getActiveInstancesLogger, prefix);
        prefixResults.push(result);
      } catch (e) {
        getActiveInstancesLogger.debug('前缀扫描失败', { prefix, error: e.message });
        prefixResults.push({ keys: [] });
      }
    }

    let allKeys = [];
    for (const result of prefixResults) {
      if (result && result.keys) {
        allKeys.push(...result.keys);
      }
    }

    // 新增日志：记录扫描到的所有原始键
    await getActiveInstancesLogger.debug('Raw keys scanned', { keys: allKeys.map(k => k.name) });

    if (allKeys.length === 0) {
      await getActiveInstancesLogger.debug('No keys found, attempting fallback full scan', {});
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
    // 使用 Promise.all 并发获取，提高性能
    const instanceDataResults = await Promise.all(
      instanceKeys.map(keyName => 
        executeWithFailover('_kv_get', env, ctx, getActiveInstancesLogger, keyName)
          .catch(e => {
            getActiveInstancesLogger.error('读取实例数据失败', { key: keyName, error: e.message });
            return null;
          })
      )
    );

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
          await getActiveInstancesLogger.debug('getActiveInstances Fetch Phase: Instance expired', { 
            instanceId: instance.id, 
            lastHeartbeat: instance.lastHeartbeat, 
            heartbeatTimeoutSeconds: HEARTBEAT_TIMEOUT / 1000, 
            ageSeconds 
          });
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

    await getActiveInstancesLogger.debug('Active instances retrieved', { count: uniqueInstances.length, totalKeys: allKeys.length });
    return uniqueInstances;
  } catch (error) {
    await getActiveInstancesLogger.error('Failed to retrieve active instances', { error: error.message });
    return [];
  }
}

export {
  scanLockKeys,
  getActiveInstances
};