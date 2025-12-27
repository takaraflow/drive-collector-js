import { afterEach } from '@jest/globals';
import { cleanupSingletonTimers } from './test-helpers.js';

/**
 * 全局测试清理
 * 在每个测试用例结束后清理单例服务定时器
 */
afterEach(async () => {
  await cleanupSingletonTimers();
});