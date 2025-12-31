import { afterEach, afterAll } from '@jest/globals';
import { cleanupSingletonTimers, quickMockCleanup } from './test-helpers.js';
import { cleanupDatabaseState, closeSharedDatabase } from './test-db.js';

/**
 * 全局测试清理
 * 在每个测试用例结束后清理单例服务定时器和 mock 状态
 */
afterEach(async () => {
  // 快速清理 mock 状态 - 仅清理调用历史，保留实现
  quickMockCleanup();
  
  // 清理单例服务定时器
  await cleanupSingletonTimers();
  
  // 清理数据库状态（仅在必要时执行或使用更高效的清理）
  cleanupDatabaseState();
});

/**
 * 所有测试完成后执行全局清理
 */
afterAll(async () => {
  // 关闭共享数据库连接
  closeSharedDatabase();
});
