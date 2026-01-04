// Mock ioredis with disconnect method
import { globalMocks } from './external-mocks.js';
import { afterEach, afterAll, jest, beforeEach } from '@jest/globals';
import { cleanupSingletonTimers, quickMockCleanup } from './test-helpers.js';
import { cleanupDatabaseState, closeSharedDatabase, resetDbTracking } from './test-db.js';
import { disableTelegramConsoleProxy, resetLogger } from '../../src/services/logger.js';
import { cache } from '../../src/services/CacheService.js';
import infisicalClient from '../../src/services/InfisicalClient.js';
import { initConfig } from '../../src/config/index.js';

// 初始化配置
beforeAll(async () => {
    // 设置测试环境的 process.env
    process.env.API_ID = '123456';
    process.env.API_HASH = 'test_hash';
    process.env.BOT_TOKEN = 'test_token';
    process.env.NODE_ENV = 'test';
    
    // 初始化配置
    await initConfig();
});

/**
 * 每个测试开始前重置数据库跟踪
 * 确保每个测试都能准确跟踪其使用的表
 */
beforeEach(() => {
  resetDbTracking();
});

/**
 * 全局测试清理
 * 在每个测试用例结束后清理单例服务定时器和 mock 状态
 */
afterEach(async () => {
  // 清理 CacheService 单例
  if (cache) {
      await cache.destroy();
  }
  
  // 清理 InfisicalClient 缓存
  if (infisicalClient && typeof infisicalClient.clearCache === 'function') {
      infisicalClient.clearCache();
  }

  // 快速清理 mock 状态 - 仅清理调用历史，保留实现
  quickMockCleanup();
  
  // 清理单例服务定时器
  await cleanupSingletonTimers();
  
  // 清理数据库状态（优化：只清理实际被使用的表）
  cleanupDatabaseState();
  
  // 重置 logger 状态（包括 console proxy）
  resetLogger();
  
  // 确保恢复 real timers（如果测试中使用了 fakeTimers）
  try {
    jest.useRealTimers();
  } catch (e) {
    // ignore if not in test environment
  }
  
  // 禁用 Telegram console proxy（如果启用）
  try {
    disableTelegramConsoleProxy();
  } catch (e) {
    // ignore
  }

  // 【关键修复】手动触发垃圾回收以防止 OOM (配合 --expose-gc 参数)
  if (global.gc) {
    global.gc();
  }
});

/**
 * 所有测试完成后执行全局清理
 */
afterAll(async () => {
  // 关闭共享数据库连接
  closeSharedDatabase();
  
  // 最终确保恢复 real timers
  try {
    jest.useRealTimers();
  } catch (e) {
    // ignore
  }
  
  // 最终禁用 console proxy
  try {
    disableTelegramConsoleProxy();
  } catch (e) {
    // ignore
  }
  
  // 最终重置 logger
  try {
    resetLogger();
  } catch (e) {
    // ignore
  }

  // 最终清理内存
  if (global.gc) {
    global.gc();
  }
});