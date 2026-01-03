#!/usr/bin/env node

/**
 * Infisical Environment Variable Sync Script
 * 
 * 统一从 Infisical 拉取环境变量，支持多种降级方案：
 * 1. CLI 模式：使用 `infisical export` (推荐，性能更好)
 * 2. API 模式：通过 REST API 获取密钥 (备用方案)
 * 3. 本地 .env 文件：作为降级缓存
 * 4. 云服务商 Dashboard：手动配置的环境变量 (当前系统自带)
 * 
 * 使用方法：
 * 1. 设置环境变量：INFISICAL_TOKEN, INFISICAL_PROJECT_ID, INFISICAL_ENV
 * 2. 可选：INFISICAL_SECRET_PATH (默认为 "/")
 * 3. 运行：node scripts/sync-env.js
 * 
 * 输出：将密钥同步到 .env 文件
 * 
 * 统一原则：无论在哪里构建，只要设置好 INFISICAL_TOKEN 等变量，
 * 都能自动从 Infisical 获取所有环境变量。
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envFilePath = path.join(projectRoot, '.env');

// 配置常量
const INFISICAL_API_BASE = 'https://app.infisical.com/api/v3';
const MAX_RETRIES = 3; // API 最大重试次数
const RETRY_DELAY = 1000; // 重试延迟（毫秒）

// 辅助函数：去除环境变量值的外层引号
function stripQuotes(value) {
    if (typeof value !== 'string') return value;
    
    // 去除首尾的空白字符
    let trimmed = value.trim();
    
    // 检查并去除外层引号（支持单引号、双引号）
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || 
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    
    return trimmed;
}

// 辅助函数：读取 .env 文件
function readEnvFile() {
    if (!fs.existsSync(envFilePath)) return {};
    const content = fs.readFileSync(envFilePath, 'utf8');
    const env = {};
    content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const [key, ...valueParts] = trimmed.split('=');
            const value = valueParts.join('=').trim();
            // 使用专门的引号处理函数
            env[key.trim()] = stripQuotes(value);
        }
    });
    return env;
}

// 辅助函数：写入 .env 文件
function writeEnvFile(envVars) {
    const currentEnv = readEnvFile();
    const merged = { ...currentEnv, ...envVars };
    
    const content = Object.entries(merged)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';
        
    fs.writeFileSync(envFilePath, content, 'utf8');
    console.log(`✅ 已更新 .env 文件，共 ${Object.keys(envVars).length} 个变量`);
}

// 辅助函数：检查本地缓存降级
function checkLocalCache() {
    console.log('🔍 检查本地缓存...');
    
    if (fs.existsSync(envFilePath)) {
        const envVars = readEnvFile();
        const count = Object.keys(envVars).length;
        
        if (count > 0) {
            console.log(`✅ 本地缓存可用：找到 ${count} 个环境变量`);
            console.log('   可用变量:', Object.keys(envVars).join(', '));
            return envVars;
        } else {
            console.log('⚠️ 本地 .env 文件存在但为空');
            return null;
        }
    } else {
        console.log('❌ 本地缓存不存在：未找到 .env 文件');
        return null;
    }
}

// 辅助函数：检查云服务商 Dashboard 配置的环境变量
function checkCloudDashboardEnv() {
    console.log('🔍 检查云服务商 Dashboard 配置的环境变量...');
    
    // 从当前进程环境变量中提取非敏感的配置信息
    // 这些通常是云服务商在部署时注入的环境变量
    const cloudEnvVars = {};
    
    // 定义需要从当前环境提取的变量列表
    const cloudVariables = [
        // Cloudflare 相关
        'CF_CACHE_ACCOUNT_ID', 'CF_CACHE_NAMESPACE_ID', 'CF_CACHE_TOKEN',
        'CF_KV_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'CF_KV_TOKEN',
        
        // Upstash 相关
        'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
        
        // QStash 相关
        'QSTASH_AUTH_TOKEN', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY',
        'QSTASH_NEXT_SIGNING_KEY', 'QSTASH_URL', 'LB_WEBHOOK_URL',
        
        // OSS 相关
        'OSS_WORKER_URL', 'OSS_WORKER_SECRET',
        
        // R2 相关
        'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET', 'R2_PUBLIC_URL',
        
        // Axiom 相关
        'AXIOM_TOKEN', 'AXIOM_ORG_ID', 'AXIOM_DATASET',
        
        // Redis 相关
        'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_TOKEN',
        'NF_REDIS_URL', 'NF_REDIS_HOST', 'NF_REDIS_PORT', 'NF_REDIS_PASSWORD',
        
        // Telegram 相关
        'API_ID', 'API_HASH', 'BOT_TOKEN', 'OWNER_ID',
        
        // Rclone 相关
        'RCLONE_REMOTE', 'REMOTE_FOLDER', 'RCLONE_CONF_BASE64',
        
        // Worker 配置
        'PORT'
    ];
    
    cloudVariables.forEach(key => {
        if (process.env[key]) {
            // 使用引号处理函数确保值格式正确
            cloudEnvVars[key] = stripQuotes(process.env[key]);
        }
    });
    
    const count = Object.keys(cloudEnvVars).length;
    
    if (count > 0) {
        console.log(`✅ 云服务商 Dashboard 配置可用：找到 ${count} 个环境变量`);
        console.log('   可用变量:', Object.keys(cloudEnvVars).join(', '));
        return cloudEnvVars;
    } else {
        console.log('⚠️ 未检测到云服务商 Dashboard 配置的环境变量');
        return null;
    }
}

// 辅助函数：延迟执行
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// API 模式带重试机制
async function syncViaAPIWithRetry() {
    const maxRetries = MAX_RETRIES;
    const isStrict = process.env.STRICT_SYNC !== '0'; // 默认为严格模式
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📡 API 模式尝试 ${attempt}/${maxRetries}...`);
            const result = await syncViaAPI();
            return result;
        } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            
            if (isLastAttempt) {
                console.error(`❌ API 模式第 ${attempt} 次尝试失败:`, error.message);
                
                // 检查是否有本地缓存可以降级
                if (!isStrict) {
                    console.log('🔄 非严格模式：尝试降级到本地缓存...');
                    const localCache = checkLocalCache();
                    if (localCache) {
                        console.log('✅ 降级成功：使用本地缓存');
                        return localCache;
                    } else {
                        console.log('❌ 本地缓存也不可用');
                        throw new Error('API 模式失败且无可用的本地缓存');
                    }
                } else {
                    console.log('🔒 严格模式：不允许降级到本地缓存');
                    throw new Error(`API 模式在 ${maxRetries} 次重试后失败（严格模式）`);
                }
            } else {
                console.warn(`⚠️ API 模式第 ${attempt} 次尝试失败:`, error.message);
                console.log(`   ${RETRY_DELAY}ms 后重试...`);
                await sleep(RETRY_DELAY);
            }
        }
    }
}

// 模式 1: CLI 模式（带降级支持）
function syncViaCLI() {
    try {
        // 检查 infisical 命令是否存在
        execSync('infisical --version', { stdio: 'ignore' });
        
        console.log('🔍 检测到 Infisical CLI，使用 CLI 模式...');
        
        const env = process.env.INFISICAL_ENV || 'prod';
        const projectId = process.env.INFISICAL_PROJECT_ID;
        const secretPath = process.env.INFISICAL_SECRET_PATH || '/';
        
        if (!projectId) {
            throw new Error('缺少 INFISICAL_PROJECT_ID 环境变量');
        }

        // 构建命令
        let cmd = `infisical export --env="${env}" --projectId="${projectId}" --format=dotenv`;
        if (secretPath !== '/') {
            cmd += ` --secretPath="${secretPath}"`;
        }

        // 执行导出
        const output = execSync(cmd, { encoding: 'utf8' });
        
        // 解析 dotenv 格式输出
        const envVars = {};
        output.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [key, ...valueParts] = trimmed.split('=');
                // 使用引号处理函数
                envVars[key.trim()] = stripQuotes(valueParts.join('=').trim());
            }
        });

        return envVars;
    } catch (error) {
        if (error.message.includes('command not found') || error.code === 'ENOENT') {
            console.log('⚠️ 未找到 Infisical CLI，将尝试 API 模式');
            return null;
        }
        
        // CLI 执行失败，提供详细信息
        console.warn('⚠️ CLI 模式执行失败:');
        if (error.status) {
            console.warn(`   退出码: ${error.status}`);
        }
        if (error.stderr) {
            console.warn(`   错误输出: ${error.stderr.toString().trim()}`);
        }
        
        // 检查是否有本地缓存
        const isStrict = process.env.STRICT_SYNC !== '0';
        if (!isStrict) {
            console.log('🔄 非严格模式：CLI 失败，后续可尝试本地缓存');
        }
        
        return null;
    }
}

// 模式 2: API 模式（基础函数，不带重试逻辑）
async function syncViaAPI() {
    const token = process.env.INFISICAL_TOKEN;
    const projectId = process.env.INFISICAL_PROJECT_ID;
    const env = process.env.INFISICAL_ENV || 'prod';
    const secretPath = process.env.INFISICAL_SECRET_PATH || '/';

    if (!token || !projectId) {
        throw new Error('缺少 INFISICAL_TOKEN 或 INFISICAL_PROJECT_ID 环境变量');
    }

    // 构建 API URL
    const url = new URL(`${INFISICAL_API_BASE}/secrets/raw`);
    url.searchParams.append('workspaceId', projectId);
    url.searchParams.append('environment', env);
    url.searchParams.append('secretPath', secretPath);

    // 使用原生 fetch (Node.js 18+)
    const response = await fetch(url.toString(), {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.secrets || !Array.isArray(data.secrets)) {
        throw new Error('API 响应格式错误');
    }

    // 转换 API 数据为 .env 格式
    const envVars = {};
    data.secrets.forEach(secret => {
        if (secret.secretKey && secret.secretValue) {
            // 使用引号处理函数
            envVars[secret.secretKey] = stripQuotes(secret.secretValue);
        }
    });

    return envVars;
}

// 主函数
async function main() {
    try {
        console.log('🚀 开始同步 Infisical 环境变量...\n');

        // 显示当前配置
        const strictMode = process.env.STRICT_SYNC !== '0';
        console.log(`📋 配置信息:`);
        console.log(`   严格模式: ${strictMode ? 'ON (必须成功)' : 'OFF (允许降级)'}`);
        console.log(`   重试次数: ${MAX_RETRIES}`);
        console.log(`   本地缓存: ${fs.existsSync(envFilePath) ? '可用' : '不可用'}\n`);

        // 检查是否提供了必要的环境变量
        if (!process.env.INFISICAL_TOKEN) {
            console.error('❌ 配置错误: 未提供 INFISICAL_TOKEN 环境变量');
            console.log('\n💡 使用方法:');
            console.log('   1. 设置环境变量:');
            console.log('      export INFISICAL_TOKEN="your-token"');
            console.log('      export INFISICAL_PROJECT_ID="your-project-id"');
            console.log('      export INFISICAL_ENV="prod" (可选，默认 prod)');
            console.log('      export INFISICAL_SECRET_PATH="/" (可选，默认 /)');
            console.log('      export STRICT_SYNC="0" (可选，关闭严格模式)');
            console.log('   2. 运行: node scripts/sync-env.js');
            console.log('\n💡 降级方案:');
            console.log('   - 开发环境：可使用本地 .env 文件缓存');
            console.log('   - 生产环境：可设置 STRICT_SYNC=0 放宽要求');
            process.exit(1);
        }

        let envVars = null;

        // 1. 尝试 CLI 模式
        try {
            envVars = syncViaCLI();
        } catch (cliError) {
            console.warn('⚠️ CLI 模式失败:', cliError.message);
            envVars = null;
        }

        // 2. 如果 CLI 不可用，尝试 API 模式（带重试和降级）
        if (!envVars) {
            try {
                envVars = await syncViaAPIWithRetry();
            } catch (apiError) {
                console.error('❌ API 模式失败:', apiError.message);
                
                // 如果是严格模式，直接退出
                if (strictMode) {
                    console.log('\n🔒 严格模式：同步失败，终止运行');
                    process.exit(1);
                }
                
                // 非严格模式下，尝试本地缓存降级
                console.log('🔄 非严格模式：尝试本地缓存降级...');
                envVars = checkLocalCache();
                
                // 3. 如果本地缓存也不可用，尝试云服务商 Dashboard 配置
                if (!envVars) {
                    console.log('🔄 本地缓存不可用：尝试云服务商 Dashboard 配置...');
                    envVars = checkCloudDashboardEnv();
                    
                    if (!envVars) {
                        console.error('\n❌ 所有同步方案均失败:');
                        console.error('   - CLI 模式: 不可用');
                        console.error('   - API 模式: 失败');
                        console.error('   - 本地缓存: 不可用');
                        console.error('   - 云服务商 Dashboard: 不可用');
                        console.log('\n💡 建议:');
                        console.log('   1. 检查网络连接');
                        console.log('   2. 验证 Infisical Token 和 Project ID');
                        console.log('   3. 或者准备本地 .env 文件作为缓存');
                        console.log('   4. 或者在云服务商 Dashboard 中配置环境变量');
                        process.exit(1);
                    }
                }
            }
        }

        // 4. 写入 .env 文件
        if (envVars && Object.keys(envVars).length > 0) {
            writeEnvFile(envVars);
            console.log('\n✅ 环境变量同步完成');
        } else {
            console.log('\n⚠️ 未获取到任何密钥，请检查项目配置');
            if (!strictMode) {
                console.log('💡 提示：当前为非严格模式，但本地缓存也为空');
            }
        }

    } catch (error) {
        console.error('\n❌ 同步失败:', error.message);
        process.exit(1);
    }
}

// 显示帮助信息
function showHelp() {
    console.log(`
Infisical 环境变量同步脚本 - 完整降级方案说明

使用方法:
  node scripts/sync-env.js

必需环境变量:
  INFISICAL_TOKEN          Infisical API Token
  INFISICAL_PROJECT_ID     项目 ID

可选环境变量:
  INFISICAL_ENV            环境 (默认: prod)
  INFISICAL_SECRET_PATH    密钥路径 (默认: /)
  STRICT_SYNC              严格模式 (默认: 1)
                           0 = 非严格模式 (允许降级)
                           1 = 严格模式 (必须成功)

完整降级链:
  1. CLI 模式 (Infisical CLI)
     ↓ 失败
  2. API 模式 (Infisical REST API)
     ↓ 失败 → 重试 3 次
  3. 本地 .env 文件缓存
     ↓ 失败
  4. 云服务商 Dashboard 配置的环境变量
     ↓ 失败
  ❌ 所有方案失败 → 退出

降级策略:
  - 严格模式 (STRICT_SYNC=1):
    CLI → API (重试3次) → 失败退出
    
  - 非严格模式 (STRICT_SYNC=0):
    CLI → API (重试3次) → 本地缓存 → 云服务商配置 → 失败退出

场景示例:
  # 开发环境 (推荐)
  export INFISICAL_TOKEN="xxx"
  export INFISICAL_PROJECT_ID="xxx"
  export STRICT_SYNC=0
  node scripts/sync-env.js

  # 生产环境 (严格模式)
  export INFISICAL_TOKEN="xxx"
  export INFISICAL_PROJECT_ID="xxx"
  export STRICT_SYNC=1
  node scripts/sync-env.js

  # 无 Infisical，仅使用云服务商配置
  export STRICT_SYNC=0
  # 确保云服务商环境变量已设置
  node scripts/sync-env.js

错误处理:
  ❌ INFISICAL_TOKEN 缺失 → 明确提示，退出
  ❌ CLI 模式失败 → 降级到 API 模式
  ❌ API 模式失败 → 重试 3 次
  ❌ API 最终失败 → 非严格模式下降级到本地缓存
  ❌ 本地缓存不存在 → 降级到云服务商配置
  ❌ 云服务商配置不存在 → 明确提示所有方案失败

引号处理:
  ✅ 自动去除环境变量值的外层引号
  ✅ 支持单引号和双引号
  ✅ 处理 CLI 和 API 返回的带引号值
  ✅ 处理 .env 文件中的带引号值
    `);
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    // 检查是否需要显示帮助
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        showHelp();
        process.exit(0);
    }
    main();
}

export {
    syncViaCLI,
    syncViaAPI,
    syncViaAPIWithRetry,
    checkLocalCache,
    checkCloudDashboardEnv,
    stripQuotes,
    showHelp,
    main
};