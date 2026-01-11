import { vi } from 'vitest';
import { Api } from 'telegram';
import { stopWatchdog as stopTelegramWatchdog } from "../../src/services/telegram.js";
import { mockRedisClient, mockCache } from "./external-mocks.js";

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
    start: vi.fn().mockResolvedValue(true),
    addEventHandler: vi.fn(),
    invoke: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ id: 1 }),
    saveSession: vi.fn().mockResolvedValue(true),
    clearSession: vi.fn().mockResolvedValue(true)
  };
}

/**
 * 创建模拟的任务管理器
 * @returns {Object} 模拟TaskManager
 */
export function createMockTaskManager() {
  return {
    init: vi.fn().mockResolvedValue(true),
    startAutoScaling: vi.fn(),
    addTask: vi.fn().mockResolvedValue('task123'),
    addBatchTasks: vi.fn().mockResolvedValue(['task1', 'task2']),
    cancelTask: vi.fn().mockResolvedValue(true),
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
    getRole: vi.fn().mockResolvedValue('user'),
    can: vi.fn().mockResolvedValue(true)
  };
}

/**
 * 创建模拟的会话管理器
 * @returns {Object} 模拟SessionManager
 */
export function createMockSessionManager() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    delete: vi.fn()
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
 * 优化：使用静态导入，避免动态导入的开销
 */
export async function cleanupSingletonTimers() {
  const cleanupPromises = [];

  // 清理 Telegram 服务定时器 - 使用静态导入的函数
  cleanupPromises.push(
    (async () => {
      try {
        if (stopTelegramWatchdog) {
          stopTelegramWatchdog();
        }
      } catch (error) {
        // console.warn('Failed to cleanup Telegram timers:', error.message);
      }
    })()
  );

  // 清理 KV 服务定时器 - 使用动态导入的缓存实例
  cleanupPromises.push(
    (async () => {
      try {
        if (mockCache) {
          if (mockCache.destroy) {
            await mockCache.destroy();
          }
          if (mockCache.stopRecoveryCheck) mockCache.stopRecoveryCheck();
          if (mockCache.stopHeartbeat) mockCache.stopHeartbeat();
        }
      } catch (error) {
        // console.warn('Failed to cleanup CacheService timers:', error.message);
      }
    })()
  );


  // 清理 InstanceCoordinator 定时器 - 使用动态导入的实例
  // 清理 Redis mock listeners - 使用静态导入的 mock
  cleanupPromises.push(
    (async () => {
      try {
        if (mockRedisClient) {
          mockRedisClient.removeAllListeners();
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
  if (typeof vi !== 'undefined') {
    // 清理所有 mock 的调用历史，但保留实现
    vi.clearAllMocks();
  }
}

/**
 * 创建测试超时包装器
 * 为慢测试提供更长的超时时间
 */
export function withTimeout(testFn, timeout = 15000) {
  return async function () {
    const originalTimeout = vi.getTimerCount();
    vi.setConfig({ testTimeout: timeout });
    
    try {
      await testFn();
    } finally {
      vi.setConfig({ testTimeout: originalTimeout });
    }
  };
}
