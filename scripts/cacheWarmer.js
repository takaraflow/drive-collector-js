/**
 * 缓存预热脚本
 * 支持启动时预热和定时预热
 */

import { cache } from '../src/services/CacheService.js';
import { logger } from '../src/services/logger/index.js';

class CacheWarmer {
  constructor() {
    this.isRunning = false;
    this.warmupConfigs = [];
    this.timers = [];
  }

  /**
   * 初始化预热配置
   */
  async init() {
    // 从环境变量加载配置
    const warmupConfig = process.env.CACHE_WARMUP_CONFIG;
    
    if (warmupConfig) {
      try {
        this.warmupConfigs = JSON.parse(warmupConfig);
        logger.info(`CacheWarmer: 加载了 ${this.warmupConfigs.length} 个预热配置`);
      } catch (err) {
        logger.error('CacheWarmer: 配置解析失败', err);
        this.warmupConfigs = [];
      }
    }

    // 默认预热配置（示例）
    if (this.warmupConfigs.length === 0) {
      this.warmupConfigs = [
        {
          name: 'user-profiles',
          keys: ['user:1001', 'user:1002', 'user:1003'],
          loader: async (key) => {
            // 模拟从数据库加载用户数据
            const userId = key.split(':')[1];
            return { id: userId, name: `User ${userId}`, email: `user${userId}@example.com` };
          },
          ttl: 3600,
          schedule: '0 6 * * *', // 每天早上6点
          enabled: true
        },
        {
          name: 'app-config',
          keys: ['config:app', 'config:features'],
          loader: async (key) => {
            // 模拟加载配置
            return { version: '1.0.0', features: ['feature1', 'feature2'] };
          },
          ttl: 7200,
          schedule: '*/30 * * * *', // 每30分钟
          enabled: true
        }
      ];
    }

    // 过滤启用的配置
    this.warmupConfigs = this.warmupConfigs.filter(config => config.enabled !== false);
  }

  /**
   * 执行单次预热
   */
  async warmup(configName = null) {
    const configs = configName 
      ? this.warmupConfigs.filter(c => c.name === configName)
      : this.warmupConfigs;

    if (configs.length === 0) {
      logger.warn(`CacheWarmer: 没有找到匹配的预热配置${configName ? ` (${configName})` : ''}`);
      return { success: 0, failed: 0 };
    }

    logger.info(`CacheWarmer: 开始预热 ${configs.length} 个配置`);

    const results = {
      total: 0,
      success: 0,
      failed: 0,
      details: []
    };

    for (const config of configs) {
      logger.info(`CacheWarmer: 预热 [${config.name}]，${config.keys.length} 个键`);

      const keys = config.keys.map(key => ({
        key,
        loader: () => config.loader(key),
        ttl: config.ttl || 3600
      }));

      const result = await cache.preheat(keys);
      
      results.total += keys.length;
      results.success += result.success;
      results.failed += result.failed;
      
      results.details.push({
        name: config.name,
        success: result.success,
        failed: result.failed,
        totalTime: result.totalTime
      });

      logger.info(`CacheWarmer: [${config.name}] 完成 - 成功: ${result.success}, 失败: ${result.failed}, 耗时: ${result.totalTime}ms`);
    }

    logger.info(`CacheWarmer: 预热完成 - 总计: ${results.total}, 成功: ${results.success}, 失败: ${results.failed}`);
    return results;
  }

  /**
   * 启动定时预热
   */
  async startScheduledWarmup() {
    if (this.isRunning) {
      logger.warn('CacheWarmer: 定时预热已在运行');
      return;
    }

    await this.init();
    
    if (this.warmupConfigs.length === 0) {
      logger.info('CacheWarmer: 没有启用的预热配置，跳过定时预热');
      return;
    }

    this.isRunning = true;
    logger.info('CacheWarmer: 启动定时预热服务');

    // 使用 node-cron 解析 cron 表达式
    try {
      const cron = require('node-cron');
      
      for (const config of this.warmupConfigs) {
        if (!config.schedule) continue;

        const task = cron.schedule(config.schedule, async () => {
          logger.info(`CacheWarmer: 定时任务触发 [${config.name}]`);
          try {
            await this.warmup(config.name);
          } catch (err) {
            logger.error(`CacheWarmer: 定时任务 [${config.name}] 失败`, err);
          }
        });

        this.timers.push(task);
        logger.info(`CacheWarmer: 已配置 [${config.name}] 的定时任务: ${config.schedule}`);
      }

      // 立即执行一次预热（可选）
      if (process.env.CACHE_WARMUP_ON_START === 'true') {
        logger.info('CacheWarmer: 启动时立即执行预热');
        setTimeout(() => this.warmup(), 5000); // 延迟5秒，等待系统初始化
      }

    } catch (err) {
      logger.error('CacheWarmer: 启动定时任务失败，node-cron 未安装或配置错误', err);
      this.isRunning = false;
    }
  }

  /**
   * 停止定时预热
   */
  stopScheduledWarmup() {
    if (!this.isRunning) {
      return;
    }

    this.timers.forEach(task => task.stop());
    this.timers = [];
    this.isRunning = false;
    logger.info('CacheWarmer: 定时预热已停止');
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      configCount: this.warmupConfigs.length,
      activeTimers: this.timers.length,
      configs: this.warmupConfigs.map(c => ({
        name: c.name,
        schedule: c.schedule || 'manual',
        keyCount: c.keys.length,
        enabled: c.enabled !== false
      }))
    };
  }

  /**
   * 清理资源
   */
  async cleanup() {
    this.stopScheduledWarmup();
    logger.info('CacheWarmer: 已清理');
  }
}

// 单例实例
const cacheWarmer = new CacheWarmer();

// 命令行接口
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  
  (async () => {
    try {
      await cache.init();
      
      switch (command) {
        case 'warmup':
          const configName = process.argv[3];
          const result = await cacheWarmer.warmup(configName);
          console.log(JSON.stringify(result, null, 2));
          break;
          
        case 'start':
          await cacheWarmer.startScheduledWarmup();
          // 保持进程运行
          process.on('SIGINT', () => {
            cacheWarmer.cleanup();
            process.exit(0);
          });
          break;
          
        case 'status':
          const status = cacheWarmer.getStatus();
          console.log(JSON.stringify(status, null, 2));
          break;
          
        default:
          console.log('Usage:');
          console.log('  node cacheWarmer.js warmup [configName]  - 执行单次预热');
          console.log('  node cacheWarmer.js start                - 启动定时预热');
          console.log('  node cacheWarmer.js status               - 查看状态');
      }
      
      await cacheWarmer.cleanup();
      process.exit(0);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  })();
}

export { CacheWarmer, cacheWarmer };