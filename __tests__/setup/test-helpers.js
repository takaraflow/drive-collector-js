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