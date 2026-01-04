// Mock ioredis with disconnect method
import { globalMocks } from './external-mocks.js';
import { afterEach, afterAll, jest, beforeEach, beforeAll } from '@jest/globals';
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
    // 获取缓存配置，避免重复初始化
    try {
        const { getConfig } = await import('../../src/config/index.js');
        getConfig();
    } catch (e) {
        await initConfig();
    }
});

/**
 * 每个测试开始前重置数据库跟踪
 */
beforeEach(() => {
  resetDbTracking();
});

/**
 * 极简清理逻辑，减少 IO 和重型操作
 */
afterEach(async () => {
  // 仅在 cache 存在时销毁
  if (cache && typeof cache.destroy === 'function') {
      await cache.destroy();
  }
  
  // 快速清理 mock 状态
  quickMockCleanup();
  
  // 移除 jest.useRealTimers() 以保持全局 fakeTimers 的状态
  // 全局 fakeTimers 由 jest.config.js 控制
});

/**
 * 所有测试完成后执行必要的全局清理
 */
afterAll(async () => {
  try {
    closeSharedDatabase();
    await cleanupSingletonTimers();
    resetLogger();
  } catch (e) {}
  
  if (global.gc) {
    global.gc();
  }
});
