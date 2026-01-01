#!/usr/bin/env node
/**
 * QStash Publish 测试脚本 (加强版 - 带 verbose 调试模式)
 */

import dotenv from 'dotenv';
import { Client } from '@upstash/qstash';
import https from 'https';
import crypto from 'crypto';

// ANSI 颜色代码
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

// 全局 verbose 标志
let verboseMode = false;

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
  if (verboseMode) {
    console.log(`${colors.cyan}📤 ${message}${colors.reset}`);
  }
}

function logVerbose(message) {
  if (verboseMode) {
    console.log(`${colors.magenta}🔍 ${message}${colors.reset}`);
  }
}

// Token 脱敏处理
function maskToken(token, showPrefix = true, showSuffix = true) {
  if (!token) return '(empty)';
  const len = token.length;
  if (len <= 8) return '*'.repeat(len);
  
  const prefix = showPrefix ? token.substring(0, 4) : '';
  const suffix = showSuffix ? token.substring(len - 4) : '';
  const middleLen = len - (showPrefix ? 4 : 0) - (showSuffix ? 4 : 0);
  const middle = '*'.repeat(middleLen);
  
  return `${prefix}${middle}${suffix}`;
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    verbose: args.includes('--verbose') || args.includes('-v')
  };
}

// Signature 计算工具函数
function calculateSignature(token, timestamp, method, path, body) {
  const messageToSign = `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
  const hmac = crypto.createHmac('sha256', token).update(messageToSign).digest('hex');
  return { messageToSign, hmac };
}

// 1. 加载 .env 环境变量
logInfo('正在加载 .env 环境变量...');
dotenv.config({ path: '.env' });

// 2. 解析命令行参数
const args = parseArgs();
verboseMode = args.verbose;

if (verboseMode) {
  logInfo('Verbose 模式已启用');
}

// 3. 验证必需的环境变量
const envValues = {
  QSTASH_TOKEN: process.env.QSTASH_TOKEN,
  QSTASH_AUTH_TOKEN: process.env.QSTASH_AUTH_TOKEN,
  LB_WEBHOOK_URL: process.env.LB_WEBHOOK_URL
};

const finalToken = (envValues.QSTASH_AUTH_TOKEN || envValues.QSTASH_TOKEN || '').trim();

if (!finalToken) {
  logError('缺失 QSTASH_TOKEN 或 QSTASH_AUTH_TOKEN');
  process.exit(1);
}

if (!envValues.LB_WEBHOOK_URL) {
  logError('缺失 LB_WEBHOOK_URL');
  process.exit(1);
}

logSuccess('环境变量加载成功');

// 4. Token 详细信息（安全脱敏）
logInfo('\n--- Token 信息安全 ---');
logInfo(`Token 总长度: ${finalToken.length}`);
logInfo(`Token 前缀: ${finalToken.substring(0, 4)}`);
logInfo(`Token 后缀: ${finalToken.substring(finalToken.length - 4)}`);
logInfo(`Token 脱敏显示: ${maskToken(finalToken)}`);

if (verboseMode) {
  logVerbose(`Token 完整长度: ${finalToken.length} 字符`);
  logVerbose(`Token 前 8 字符: ${finalToken.substring(0, 8)}`);
  logVerbose(`Token 后 8 字符: ${finalToken.substring(finalToken.length - 8)}`);
  logVerbose(`Token 中间部分: ${'*'.repeat(Math.max(0, finalToken.length - 16))}`);
}

// 5. 准备测试数据
const testTopic = 'test-auth';
const testMessage = { test: true, timestamp: Date.now() };
const testUrl = `${envValues.LB_WEBHOOK_URL}/api/tasks/${testTopic}`;

logInfo('\n--- 测试数据 ---');
logInfo(`Topic: ${testTopic}`);
logInfo(`URL: ${testUrl}`);
logInfo(`Message: ${JSON.stringify(testMessage)}`);

// 6. 执行测试
async function runTests() {
  // 测试 1: SDK Client 初始化和发布
  logInfo('\n--- 测试 1: @upstash/qstash SDK ---');
  
  if (verboseMode) {
    logVerbose('初始化 SDK Client...');
    logVerbose(`Client 配置: { token: "${maskToken(finalToken)}" }`);
  }
  
  try {
    const client = new Client({ token: finalToken });
    
    if (verboseMode) {
      logVerbose('Client 初始化完成');
      logVerbose('准备调用 client.publishJSON()...');
      logVerbose(`请求参数: ${JSON.stringify({
        url: testUrl,
        body: JSON.stringify(testMessage),
        headers: { 'Content-Type': 'application/json' }
      }, null, 2)}`);
    }
    
    const result = await client.publishJSON({
      url: testUrl,
      body: JSON.stringify(testMessage),
      headers: { 'Content-Type': 'application/json' }
    });
    
    logSuccess(`SDK 发布成功！MsgID: ${result.messageId}`);
    
    if (verboseMode) {
      logVerbose(`SDK 响应完整数据: ${JSON.stringify(result, null, 2)}`);
    }
  } catch (error) {
    logError(`SDK 发布失败: ${error.message}`);
    if (verboseMode) {
      logVerbose(`SDK 错误详情: ${JSON.stringify(error, null, 2)}`);
    }
  }

  // 测试 2: Raw HTTPS 请求（详细日志 + URL 编码优化）
  logInfo('\n--- 测试 2: Raw HTTPS Module ---');
  
  // URL 编码处理
  const encodedUrl = encodeURIComponent(testUrl);
  const rawPath = `/v2/publish/${encodedUrl}`;
  const qstashApiUrl = `https://qstash.upstash.io${rawPath}`;
  const postData = JSON.stringify(testMessage);
  
  if (verboseMode) {
    logVerbose('准备 Raw HTTP 请求...');
    logVerbose('\n--- URL 编码对比 ---');
    logVerbose(`原始 URL: ${testUrl}`);
    logVerbose(`编码后 URL: ${encodedUrl}`);
    logVerbose(`完整 API URL: ${qstashApiUrl}`);
    logVerbose(`原始 Path: /v2/publish/${testUrl}`);
    logVerbose(`编码后 Path: ${rawPath}`);
    logVerbose(`\n⚠️  关键差异: 原始路径包含 "://" 等特殊字符，必须编码！`);
    
    logVerbose('\n--- 请求详情 ---');
    logVerbose(`Method: POST`);
    logVerbose(`Headers: ${JSON.stringify({
      'Authorization': `Bearer ${maskToken(finalToken)}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }, null, 2)}`);
    logVerbose(`Body: ${postData}`);
    
    // Signature 计算演示（仅用于调试）
    const timestamp = Math.floor(Date.now() / 1000);
    const signatureInfo = calculateSignature(finalToken, timestamp, 'POST', rawPath, postData);
    logVerbose('\n--- Signature 计算步骤 ---');
    logVerbose(`Timestamp: ${timestamp}`);
    logVerbose(`Method: POST`);
    logVerbose(`Path (编码后): ${rawPath}`);
    logVerbose(`Body: ${postData}`);
    logVerbose(`MessageToSign: ${signatureInfo.messageToSign}`);
    logVerbose(`HMAC-SHA256: ${signatureInfo.hmac}`);
  } else {
    logInfo(`请求 API: ${qstashApiUrl}`);
    logInfo(`Path (编码后): ${rawPath}`);
  }
  
  try {
    const options = {
      hostname: 'qstash.upstash.io',
      path: rawPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${finalToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      if (verboseMode) {
        logVerbose('\n--- Response Headers ---');
        logVerbose(`Status: ${res.statusCode} ${res.statusMessage}`);
        logVerbose(`Headers: ${JSON.stringify(res.headers, null, 2)}`);
      }
      
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (verboseMode) {
          logVerbose('\n--- Response Body ---');
          logVerbose(`Raw Response: ${data}`);
        }
        
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logSuccess(`HTTPS 发布成功！状态码: ${res.statusCode}`);
          if (!verboseMode) {
            logDebug(`响应内容: ${data}`);
          }
        } else {
          logError(`HTTPS 发布失败！状态码: ${res.statusCode}`);
          logDebug(`响应内容: ${data}`);
          
          if (res.statusCode === 401) {
            log('\n--- 🆘 401 故障排查建议 ---', 'yellow');
            log('1. 确认 Token 类型: Upstash Console -> QStash -> "REST API" 页面顶部的 Token。', 'yellow');
            log('2. 确认 Token 完整性: 检查 .env 是否有引号包裹或尾随空格。', 'yellow');
            log('3. 检查 Key 状态: 确认该 Key 未被撤销或禁用。', 'yellow');
            if (verboseMode) {
              logVerbose('4. 检查 Token 权限: 确认 Token 具有 publish 权限。', 'yellow');
            }
          }
        }
      });
    });

    req.on('error', (e) => {
      logError(`HTTPS 请求异常: ${e.message}`);
      if (verboseMode) {
        logVerbose(`异常详情: ${JSON.stringify(e, null, 2)}`);
      }
    });

    req.write(postData);
    req.end();
  } catch (error) {
    logError(`测试 2 异常: ${error.message}`);
    if (verboseMode) {
      logVerbose(`异常堆栈: ${error.stack}`);
    }
  }
}

// 7. 运行测试
logInfo('\n=== 开始 QStash 发布测试 ===');
runTests().then(() => {
  logInfo('\n=== 测试执行完成 ===');
  if (verboseMode) {
    logVerbose('Verbose 模式下所有调试信息已输出');
  }
  logInfo('使用 --verbose 或 -v 参数启用详细调试模式');
}).catch((error) => {
  logError(`测试执行失败: ${error.message}`);
  if (verboseMode) {
    logVerbose(`错误堆栈: ${error.stack}`);
  }
});