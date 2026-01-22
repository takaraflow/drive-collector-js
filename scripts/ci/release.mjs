#!/usr/bin/env node

/**
 * CI Release Manager
 * 处理版本发布、重试、通知等逻辑
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

class ReleaseManager {
  constructor() {
    this.projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    this.config = null;
    this.version = null;
    this.environment = null;
  }

  /**
   * 加载配置
   */
  loadConfig() {
    console.log('📋 加载配置...');
    
    const configPath = join(this.projectRoot, 'cicd/config.yaml');
    if (!existsSync(configPath)) {
      throw new Error(`配置文件不存在: ${configPath}`);
    }
    
    // 简单的 YAML 解析（不依赖 yaml 包）
    const configContent = readFileSync(configPath, 'utf8');
    this.config = this.parseYAML(configContent);
    console.log('✅ 配置加载成功');
  }

  /**
   * 简单的 YAML 解析器
   */
  parseYAML(content) {
    const lines = content.split('\n');
    const result = {};
    let currentSection = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      if (trimmed.endsWith(':')) {
        currentSection = trimmed.slice(0, -1);
        result[currentSection] = {};
      } else if (trimmed.includes(':')) {
        const [key, ...valueParts] = trimmed.split(':');
        const value = valueParts.join(':').trim();
        
        if (currentSection) {
          result[currentSection][key.trim()] = value;
        } else {
          result[key.trim()] = value;
        }
      }
    }
    
    return result;
  }

  /**
   * 获取当前版本
   */
  getVersion() {
    console.log('📦 获取当前版本...');
    
    const packageJsonPath = join(this.projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    this.version = packageJson.version;
    
    console.log(`   当前版本: ${this.version}`);
    return this.version;
  }

  /**
   * 确定环境
   */
  determineEnvironment() {
    console.log('🌍 确定环境...');
    
    const branch = process.env.GITHUB_REF || 'unknown';
    
    if (branch.includes('refs/heads/main')) {
      this.environment = 'prod';
    } else if (branch.includes('refs/heads/develop')) {
      this.environment = 'pre';
    } else {
      this.environment = 'dev';
    }
    
    console.log(`   环境: ${this.environment}`);
    return this.environment;
  }

  /**
   * 生成发布策略
   */
  generateReleaseStrategy() {
    console.log('🎯 生成发布策略...');
    
    const strategy = {
      environment: this.environment,
      version: this.version,
      shouldRelease: false,
      releaseType: null,
      notify: true,
      retry: {
        maxAttempts: 3,
        backoff: 2000
      }
    };

    // 根据环境决定发布策略
    if (this.environment === 'prod') {
      strategy.shouldRelease = true;
      strategy.releaseType = 'production';
      strategy.notify = true;
    } else if (this.environment === 'pre') {
      strategy.shouldRelease = true;
      strategy.releaseType = 'pre-release';
      strategy.notify = true;
    } else {
      strategy.shouldRelease = false;
      strategy.releaseType = 'development';
      strategy.notify = false;
    }

    console.log('   发布策略:');
    console.log(`     - 环境: ${strategy.environment}`);
    console.log(`     - 版本: ${strategy.version}`);
    console.log(`     - 发布: ${strategy.shouldRelease ? '✅' : '❌'}`);
    console.log(`     - 类型: ${strategy.releaseType}`);
    console.log(`     - 通知: ${strategy.notify ? '✅' : '❌'}`);

    return strategy;
  }

  /**
   * 执行带重试的操作
   */
  async executeWithRetry(command, description, maxAttempts = 3, backoff = 2000) {
    console.log(`🔄 ${description} (最多 ${maxAttempts} 次尝试)...`);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`   尝试 ${attempt}/${maxAttempts}...`);
      
      try {
        execSync(command, {
          stdio: 'inherit',
          cwd: this.projectRoot
        });
        
        console.log(`   ✅ ${description} 成功`);
        return { success: true, attempt };
      } catch (error) {
        console.error(`   ❌ 尝试 ${attempt} 失败: ${error.message}`);
        
        if (attempt < maxAttempts) {
          const waitTime = backoff * attempt;
          console.log(`   ⏳ 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          console.error(`   ❌ ${description} 最终失败`);
          return { success: false, attempt, error };
        }
      }
    }
  }

  /**
   * 执行发布
   */
  async executeRelease() {
    console.log('🚀 执行发布...');
    
    const strategy = this.generateReleaseStrategy();
    
    if (!strategy.shouldRelease) {
      console.log('   ⏭️ 跳过发布（非生产/预发布环境）');
      return { success: true, skipped: true };
    }

    // 执行发布命令
    const releaseCommand = `npm run release`;
    const result = await this.executeWithRetry(
      releaseCommand,
      '执行发布',
      strategy.retry.maxAttempts,
      strategy.retry.backoff
    );

    return result;
  }

  /**
   * 发送通知
   */
  async sendNotification(status, details = {}) {
    console.log('📢 发送通知...');
    
    const webhookUrl = process.env.BARK_WEBHOOK_URL;
    const deviceToken = process.env.BARK_DEVICE_TOKEN;
    
    if (!webhookUrl || !deviceToken) {
      console.log('   ⏭️ 通知配置缺失');
      return;
    }

    const title = status === 'success' 
      ? `✅ 发布成功 [${this.environment}]`
      : `❌ 发布失败 [${this.environment}]`;

    const content = `版本: ${this.version}\n环境: ${this.environment}\n状态: ${status}\n时间: ${new Date().toISOString()}`;

    try {
      const baseUrl = webhookUrl.replace(/\/$/, '');
      
      execSync(`curl -L -X POST "${baseUrl}/push" \
        -H "Content-Type: application/json; charset=utf-8" \
        -d "{
          \"title\": \"${title}\",
          \"body\": \"${content}\",
          \"device_key\": \"${deviceToken}\",
          \"group\": \"RELEASE\"
        }"`, { stdio: 'pipe' });
      
      console.log('✅ 通知发送成功');
    } catch (error) {
      console.error('⚠️ 通知发送失败:', error.message);
    }
  }

  /**
   * 运行完整的发布流程
   */
  async runReleasePipeline() {
    console.log('🚀 开始发布流程...\n');
    
    try {
      // 1. 加载配置
      this.loadConfig();
      
      // 2. 获取版本
      this.getVersion();
      
      // 3. 确定环境
      this.determineEnvironment();
      
      // 4. 执行发布
      const releaseResult = await this.executeRelease();
      
      // 5. 发送通知
      if (releaseResult.success) {
        await this.sendNotification('success');
      } else {
        await this.sendNotification('failure', { error: releaseResult.error?.message });
      }
      
      console.log('\n✅ 发布流程完成!');
      return releaseResult.success;
      
    } catch (error) {
      console.error('\n❌ 发布流程失败:', error.message);
      await this.sendNotification('failure', { error: error.message });
      return false;
    }
  }
}

// CLI 接口
const main = async () => {
  console.log('🔧 CI Release Manager 启动...\n');
  
  const manager = new ReleaseManager();
  const command = process.argv[2] || 'release';
  
  try {
    switch (command) {
      case 'release':
        console.log('🚀 执行发布流程...');
        const result = await manager.runReleasePipeline();
        process.exit(result ? 0 : 1);
        
      case 'strategy':
        console.log('🎯 生成发布策略...');
        manager.loadConfig();
        manager.getVersion();
        manager.determineEnvironment();
        const strategy = manager.generateReleaseStrategy();
        console.log('\n发布策略:', JSON.stringify(strategy, null, 2));
        process.exit(0);
        
      case 'notify':
        console.log('📢 测试通知...');
        manager.getVersion();
        manager.determineEnvironment();
        await manager.sendNotification('success');
        process.exit(0);
        
      default:
        console.log(`❌ 未知命令: ${command}`);
        console.log(`
用法: node scripts/ci/release.mjs <command>

命令:
  release   执行完整的发布流程
  strategy  生成发布策略
  notify    测试通知

示例:
  node scripts/ci/release.mjs release
  node scripts/ci/release.mjs strategy
  node scripts/ci/release.mjs notify
        `);
        process.exit(1);
    }
  } catch (error) {
    console.error('❌ 执行失败:', error.message);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('脚本执行错误:', error);
    process.exit(1);
  });
}

export default ReleaseManager;