import { jest } from '@jest/globals';
import { Api } from 'telegram';

/**
 * 创建模拟的Telegram消息事件
 * @param {string} messageText - 消息文本
 * @param {string} userId - 用户ID
 * @returns {Object} 模拟事件对象
 */
export function createMockMessageEvent(messageText, userId = '123') {
  // Extract numeric part if userId contains non-numeric characters
  const userIdStr = userId.toString();
  const userIdNum = parseInt(userIdStr.replace(/\D/g, '')) || 123;
  return {
    message: {
      id: 1,
      message: messageText,
      fromId: { userId: BigInt(userIdNum) },
      peerId: { userId: BigInt(userIdNum), className: 'PeerUser' },
      className: 'Message'
    },
    className: 'UpdateNewMessage'
  };
}

/**
 * 创建模拟的Telegram回调事件
 * @param {string} callbackData - 回调数据
 * @param {string} userId - 用户ID
 * @returns {Object} 模拟事件对象
 */
export function createMockCallbackEvent(callbackData, userId = '123') {
  const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
  return new Api.UpdateBotCallbackQuery({
    data: Buffer.from(callbackData),
    userId: BigInt(userIdNum),
    queryId: BigInt(1),
    peer: new Api.PeerUser({ userId: BigInt(userIdNum) }),
    msgId: 456
  });
}

/**
 * 创建模拟的Telegram客户端
 * @returns {Object} 模拟客户端
 */
export function createMockTelegramClient() {
  return {
    start: jest.fn().mockResolvedValue(true),
    addEventHandler: jest.fn(),
    invoke: jest.fn().mockResolvedValue(true),
    sendMessage: jest.fn().mockResolvedValue({ id: 1 }),
    saveSession: jest.fn().mockResolvedValue(true),
    clearSession: jest.fn().mockResolvedValue(true)
  };
}

/**
 * 创建模拟的任务管理器
 * @returns {Object} 模拟TaskManager
 */
export function createMockTaskManager() {
  return {
    init: jest.fn().mockResolvedValue(true),
    startAutoScaling: jest.fn(),
    addTask: jest.fn().mockResolvedValue('task123'),
    addBatchTasks: jest.fn().mockResolvedValue(['task1', 'task2']),
    cancelTask: jest.fn().mockResolvedValue(true),
    waitingTasks: [],
    currentTask: null
  };
}

/**
 * 创建模拟的认证守卫
 * @returns {Object} 模拟AuthGuard
 */
export function createMockAuthGuard() {
  return {
    getRole: jest.fn().mockResolvedValue('user'),
    can: jest.fn().mockResolvedValue(true)
  };
}

/**
 * 创建模拟的会话管理器
 * @returns {Object} 模拟SessionManager
 */
export function createMockSessionManager() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    delete: jest.fn()
  };
}

/**
 * 重置所有模拟对象
 * @param {Object} mocks - 模拟对象集合
 */
export function resetAllMocks(mocks) {
  Object.values(mocks).forEach(mock => {
    if (typeof mock === 'object' && mock !== null) {
      Object.values(mock).forEach(method => {
        if (typeof method === 'function' && method.mockReset) {
          method.mockReset();
        }
      });
    }
  });
}

/**
 * 清理已知的单例服务定时器
 * 用于防止测试间的定时器泄露
 * 优化：使用更高效的清理策略，减少不必要的导入
 */
export async function cleanupSingletonTimers() {
  // 优化：只在需要时导入，避免每次调用都尝试导入
  const cleanupPromises = [];

  // 清理 Telegram 服务定时器
  cleanupPromises.push(
    (async () => {
      try {
        const module = await import("../../src/services/telegram.js");
        if (module.stopWatchdog) {
          module.stopWatchdog();
        }
      } catch (error) {
        // console.warn('Failed to cleanup Telegram timers:', error.message);
      }
    })()
  );

  // 清理 KV 服务定时器
  cleanupPromises.push(
    (async () => {
      try {
        const module = await import("../../src/services/CacheService.js");
        if (module.cache) {
          if (module.cache.destroy) {
            await module.cache.destroy();
          }
          if (module.cache.stopRecoveryCheck) module.cache.stopRecoveryCheck();
          if (module.cache.stopHeartbeat) module.cache.stopHeartbeat(); // 使用公共方法
        }
      } catch (error) {
        // console.warn('Failed to cleanup CacheService timers:', error.message);
      }
    })()
  );

  // 清理 InstanceCoordinator 定时器
  cleanupPromises.push(
    (async () => {
      try {
        const module = await import("../../src/services/InstanceCoordinator.js");
        if (module.instanceCoordinator && module.instanceCoordinator.stopHeartbeat) {
          module.instanceCoordinator.stopHeartbeat();
        }
      } catch (error) {
        // console.warn('Failed to cleanup InstanceCoordinator timers:', error.message);
      }
    })()
  );

  // 清理 Redis mock listeners
  cleanupPromises.push(
    (async () => {
      try {
        const mocks = await import("./external-mocks.js");
        if (mocks.mockRedisClient) {
          mocks.mockRedisClient.removeAllListeners();
        }
      } catch (error) {
        // console.warn('Failed to cleanup Redis listeners:', error.message);
      }
    })()
  );

  // 并行执行所有清理操作
  await Promise.allSettled(cleanupPromises);
}

/**
 * 快速清理所有 Jest mock 状态
 * 优化：只清理必要的 mock，避免过度重置
 */
export function quickMockCleanup() {
  // 只清理全局 mock 函数，不清理其他状态
  if (typeof jest !== 'undefined') {
    // 清理所有 mock 的调用历史，但保留实现
    jest.clearAllMocks();
  }
}

/**
 * 创建测试超时包装器
 * 为慢测试提供更长的超时时间
 */
export function withTimeout(testFn, timeout = 15000) {
  return async function () {
    const originalTimeout = jest.setTimeout;
    jest.setTimeout(timeout);
    
    try {
      await testFn();
    } finally {
      jest.setTimeout(originalTimeout);
    }
  };
}
