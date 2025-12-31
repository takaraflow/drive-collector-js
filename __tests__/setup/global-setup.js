import { afterEach, afterAll } from '@jest/globals';
import { cleanupSingletonTimers, quickMockCleanup } from './test-helpers.js';
import { cleanupDatabaseState, closeSharedDatabase } from './test-db.js';

/**
 * 全局测试清理
 * 在每个测试用例结束后清理单例服务定时器和 mock 状态
 */
afterEach(async () => {
  // 快速清理 mock 状态
  quickMockCleanup();
  
  // 清理数据库状态（但不关闭连接）
  cleanupDatabaseState();
  
  // 清理定时器
  await cleanupSingletonTimers();
});

/**
 * 所有测试完成后执行全局清理
 */
afterAll(async () => {
  // 关闭共享数据库连接
  closeSharedDatabase();
});
