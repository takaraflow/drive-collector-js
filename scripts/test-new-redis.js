/**
 * @file scripts/test-new-redis.js
 * @description 用于验证 src/index.js 中重命名后的 redis 调用逻辑是否正常。
 * @usage node scripts/test-new-redis.js
 * @dependencies npm i dotenv (已在 package.json 中确认安装)
 */

import 'dotenv/config'; // 加载 .env 环境变量

// 从 redis-utils.js 导入 Redis 相关函数和 logger
import {
  getRedisClient,
  executeRedis,
  executeRedisScan,
  checkRedisHealth,
  logger // 导入 logger 以便在测试脚本中使用
} from './redis-utils.js';

// 创建一个模拟的 env 对象
const mockEnv = {
  NF_REDIS_URL: process.env.NF_REDIS_URL || 'redis://localhost:6379',
  NF_REDIS_PASSWORD: process.env.NF_REDIS_PASSWORD || undefined,
  NODE_ENV: 'test',
};

async function runRedisTests() {
  console.log('--- 开始 Redis 功能验证 ---');

  // 配置 logger 为测试环境 (现在在 redis-utils.js 中也配置了)
  logger.configure({ env: 'test' });

  let redisClient;
  try {
    redisClient = await getRedisClient(mockEnv, null); // 传入 mockEnv 和 null (ctx)
    console.log('Redis 客户端初始化成功。');
  } catch (error) {
    console.error('Redis 客户端初始化失败:', error.message);
    return;
  }

  // 1. 健康检查
  console.log('\n--- 执行健康检查 ---');
  try {
    const health = await checkRedisHealth(mockEnv, null); // 传入 mockEnv 和 null (ctx)
    console.log('健康检查结果:', health ? '通过' : '失败');
  } catch (error) {
    console.error('健康检查失败:', error.message);
  }

  // 2. Set/Get 操作
  console.log('\n--- 执行 Set/Get 操作 ---');
  const testKey = `test:key:${Date.now()}`;
  const testValue = 'hello_redis_from_worker';
  try {
    const setResult = await executeRedis('_redis_put', mockEnv, testKey, testValue);
    console.log(`SET ${testKey} = ${testValue} -> 结果:`, setResult);

    const getResult = await executeRedis('_redis_get', mockEnv, testKey);
    console.log(`GET ${testKey} -> 结果:`, getResult);

    if (getResult === testValue) {
      console.log('Set/Get 验证成功！');
    } else {
      console.error('Set/Get 验证失败: 获取的值不匹配。');
    }
  } catch (error) {
    console.error('Set/Get 操作失败:', error.message);
  } finally {
    // 清理测试数据
    try {
      await executeRedis('del', mockEnv, testKey);
      console.log(`清理测试键 ${testKey} 成功。`);
    } catch (error) {
      console.warn(`清理测试键 ${testKey} 失败 (可能已不存在):`, error.message);
    }
  }

  // 3. Scan 操作 (查找所有测试键)
  console.log('\n--- 执行 Scan 操作 ---');
  const scanKeyPattern = 'test:*';
  try {
    const scanResult = await executeRedisScan(mockEnv, 'test:');
    const keys = scanResult.keys.map(k => k.name);

    console.log(`扫描到匹配 '${scanKeyPattern}' 的键 (${keys.length} 个):`, keys);
    if (keys.length > 0) {
      console.log('Scan 验证成功！');
    } else {
      console.warn('Scan 验证完成: 未找到匹配的键。');
    }
  } catch (error) {
    console.error('Scan 操作失败:', error.message);
  }

  console.log('\n--- Redis 功能验证完成 ---');
  if (redisClient && typeof redisClient.disconnect === 'function') {
    redisClient.disconnect();
    console.log('Redis 客户端已断开连接。');
  } else {
    console.warn('无法断开 Redis 客户端连接。');
  }
}

runRedisTests().catch(error => {
  console.error('测试执行过程中发生未捕获错误:', error);
  process.exit(1);
});
