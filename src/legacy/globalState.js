/**
 * 全局状态管理模块
 * 处理故障转移和提供者状态
 */

import { logger } from '../logger.js';

// 向后兼容的全局变量
let currentProvider = 'cloudflare';
let failureCount = 0;
let lastFailureTime = 0;
let failoverReason = '';

/**
 * 获取当前提供者
 * @returns {Promise<string>} 当前提供者
 */
async function getCurrentProvider() {
  return currentProvider;
}

/**
 * 检查是否应该故障转移
 * @param {number} maxFailures - 最大失败次数
 * @param {number} cooldownMs - 冷却时间（毫秒）
 * @returns {Promise<boolean>} 是否应该故障转移
 */
async function shouldFailover(maxFailures, cooldownMs) {
  return failureCount >= maxFailures && (Date.now() - lastFailureTime) >= cooldownMs;
}

/**
 * 增加失败计数
 * @param {string} reason - 失败原因
 * @returns {Promise<Object>} 当前状态
 */
async function incrementFailureCount(reason) {
  failureCount++;
  lastFailureTime = Date.now();
  failoverReason = reason;
  return { failureCount, lastFailureTime, failoverReason };
}

/**
 * 重置失败计数
 * @returns {Promise<Object>} 重置后的状态
 */
async function resetFailureCount() {
  failureCount = 0;
  lastFailureTime = 0;
  failoverReason = '';
  return { failureCount: 0, lastFailureTime: 0, failoverReason: '' };
}

/**
 * 切换提供者
 * @param {string} provider - 新提供者
 * @param {string} reason - 切换原因
 * @returns {Promise<Object>} 新状态
 */
async function switchProvider(provider, reason) {
  currentProvider = provider;
  failoverReason = reason;
  return { currentProvider, failoverReason };
}

/**
 * 故障转移逻辑
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<boolean>} 是否成功故障转移
 */
async function failover(env, ctx = null, requestLogger = null) {
  const failoverLogger = requestLogger || logger.child({ module: 'failover' });
  const hasUpstash = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN;

  // 优先级：Upstash
  if (hasUpstash) {
    await switchProvider('upstash', 'Automatic failover');
    failoverLogger.info('🔄 故障转移到 Upstash Redis (Failover to Upstash Redis)', { 
      reason: 'Automatic failover' 
    });
    return true;
  }

  return false;
}

/**
 * 检查错误是否可重试
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否可重试
 */
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
 * 触发故障转移检查
 * @param {Error} error - 错误对象
 * @param {Object} env - 环境变量
 * @returns {boolean} 是否应该触发故障转移
 */
function shouldTriggerFailover(error, env) {
  // 检查是否有可用的故障转移提供者
  const hasUpstash = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN;

  if (!hasUpstash) {
    return false;
  }

  // 如果当前已经是故障转移模式，不再故障转移
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

// 状态访问器（供测试使用）
const getCurrentProviderState = () => ({ currentProvider, failureCount, lastFailureTime, failoverReason });
const setCurrentProviderState = (state) => {
  if (state.currentProvider !== undefined) currentProvider = state.currentProvider;
  if (state.failureCount !== undefined) failureCount = state.failureCount;
  if (state.lastFailureTime !== undefined) lastFailureTime = state.lastFailureTime;
  if (state.failoverReason !== undefined) failoverReason = state.failoverReason;
};

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
};