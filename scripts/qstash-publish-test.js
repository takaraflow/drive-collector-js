#!/usr/bin/env node
/**
 * QStash Publish 测试脚本
 * 
 * 功能：
 * 1. 加载 .env 环境变量
 * 2. 验证 QSTASH_TOKEN 和 LB_WEBHOOK_URL
 * 3. 使用 @upstash/qstash Client 发送测试消息
 * 4. 验证认证是否通过，输出详细结果
 * 
 * 运行：node scripts/qstash-publish-test.js
 * 
 * 注意：此脚本独立运行，不依赖项目启动
 */

import dotenv from 'dotenv';
import { Client } from '@upstash/qstash';

// ANSI 颜色代码，用于美化输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logError(message) {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function logInfo(message) {
  console.log(`${colors.blue}ℹ ${message}${colors.reset}`);
}

function logDebug(message) {
  console.log(`${colors.cyan}📤 ${message}${colors.reset}`);
}

// 1. 加载 .env 环境变量
logInfo('正在加载 .env 环境变量...');
const envResult = dotenv.config({ path: '.env' });

if (envResult.error) {
  logError(`无法加载 .env 文件: ${envResult.error.message}`);
  logInfo('请确保 .env 文件存在于项目根目录');
  process.exit(1);
}

logSuccess('.env 文件加载成功');

// 2. 验证必需的环境变量
const envValues = {
  QSTASH_TOKEN: process.env.QSTASH_TOKEN,
  QSTASH_AUTH_TOKEN: process.env.QSTASH_AUTH_TOKEN,
  LB_WEBHOOK_URL: process.env.LB_WEBHOOK_URL,
  QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY
};

// 确定最终使用的 Token
const finalToken = envValues.QSTASH_AUTH_TOKEN || envValues.QSTASH_TOKEN;

if (!finalToken || finalToken.trim() === '') {
  logError('缺失必需的环境变量: QSTASH_AUTH_TOKEN 或 QSTASH_TOKEN');
  logInfo('请在 .env 文件中设置其中之一 (QStash REST API Token)');
  process.exit(1);
}

if (!envValues.LB_WEBHOOK_URL) {
  logError('缺失必需的环境变量: LB_WEBHOOK_URL');
  process.exit(1);
}

// 检查 Token 前缀
if (finalToken.startsWith('sig_')) {
  logError(`检测到配置错误: Token 以 'sig_' 开头。`);
  log('   这是 Signing Key，不是 Authorization Token！', 'yellow');
  log('   请从 Upstash 控制台获取 Authorization Token (通常以 authorization_ 开头)。', 'yellow');
  if (envValues.QSTASH_CURRENT_SIGNING_KEY && envValues.QSTASH_CURRENT_SIGNING_KEY === finalToken) {
    log('   提示：你似乎将 Signing Key 同时填入了 Token 变量中。', 'cyan');
  }
}

logSuccess('环境变量验证通过');

// 3. 显示配置信息（脱敏）
logInfo('配置信息:');
log(`  Used Token: ${finalToken.slice(0, 15)}...${finalToken.slice(-5)}`, 'cyan');
log(`  LB_WEBHOOK_URL: ${envValues.LB_WEBHOOK_URL}`, 'cyan');

// 4. 创建 QStash Client
logInfo('正在创建 QStash Client...');
let client;
try {
  client = new Client({ token: finalToken });
  logSuccess('QStash Client 创建成功');
} catch (error) {
  logError(`创建 Client 失败: ${error.message}`);
  process.exit(1);
}

// 5. 准备测试数据
const testTopic = 'test-auth';
const testMessage = {
  test: true,
  timestamp: Date.now(),
  message: 'QStash 认证测试消息'
};
const testUrl = `${envValues.LB_WEBHOOK_URL}/api/tasks/${testTopic}`;

logInfo('准备测试数据:');
logDebug(`  Topic: ${testTopic}`);
logDebug(`  URL: ${testUrl}`);
logDebug(`  Message: ${JSON.stringify(testMessage)}`);

// 6. 执行 publish 测试
logInfo('正在执行 publish 测试...');

async function runTest() {
  let startTime;
  try {
    startTime = performance.now();
    
    const result = await client.publishJSON({
      url: testUrl,
      body: JSON.stringify(testMessage),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const duration = performance.now() - startTime;
    
    logSuccess(`发布成功！耗时: ${duration.toFixed(2)}ms`);
    log(`  MessageId: ${result.messageId}`, 'green');
    log(`  完整响应: ${JSON.stringify(result, null, 2)}`, 'cyan');
    
    logInfo('✅ 认证通过！QStash Token 有效');
    logInfo('💡 提示：如果线上仍失败，请检查:');
    log('   1. 项目中 config/index.js 是否正确加载 QSTASH_TOKEN', 'yellow');
    log('   2. 线上环境变量是否与本地一致', 'yellow');
    log('   3. 网络策略是否允许出站请求到 QStash API', 'yellow');
    
    process.exit(0);
    
  } catch (error) {
    const duration = startTime ? performance.now() - startTime : 0;
    
    logError(`发布失败！耗时: ${duration.toFixed(2)}ms`);
    log(`  错误信息: ${error.message}`, 'red');
    
    // 详细错误分析
    if (error.message.includes('unable to authenticate') || error.message.includes('invalid token') || error.message.includes('401')) {
      logInfo('🔍 认证失败诊断:');
      log('   - Token 可能已过期或无效', 'yellow');
      log('   - 请在 Upstash 控制台检查 Token 状态', 'yellow');
      log('   - 路径: Upstash -> QStash -> Tokens', 'yellow');
      log('   - 建议: 生成新 Token 并更新 .env', 'yellow');
    } else if (error.message.includes('400') || error.message.includes('422')) {
      logInfo('🔍 请求格式错误:');
      log('   - URL 格式可能不正确', 'yellow');
      log('   - 检查 LB_WEBHOOK_URL 是否包含协议和域名', 'yellow');
    } else if (error.message.includes('403')) {
      logInfo('🔍 权限错误:');
      log('   - Token 可能缺少必要权限', 'yellow');
      log('   - 检查 Token 的 Scope 设置', 'yellow');
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      logInfo('🔍 网络错误:');
      log('   - 无法连接到 QStash API', 'yellow');
      log('   - 检查网络连接或代理设置', 'yellow');
    } else {
      logInfo('🔍 未知错误:');
      log('   - 请复制完整错误信息反馈', 'yellow');
    }
    
    log(`\n完整错误对象:`, 'cyan');
    console.error(error);
    
    process.exit(1);
  }
}

runTest();