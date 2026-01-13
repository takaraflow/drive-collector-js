#!/usr/bin/env node

/**
 * D1 数据库详细诊断脚本 (全功能版)
 * 集成了环境变量修复、占位符处理及 API 异常捕获测试
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// 加载配置：支持系统环境变量与 .env 文件的优先级融合
function loadEnvConfig() {
    const envPath = join(process.cwd(), '.env');
    const config = {};
    
    if (existsSync(envPath)) {
        try {
            const envContent = readFileSync(envPath, 'utf8');
            envContent.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const [key, ...parts] = trimmed.split('=');
                    const keyTrim = key.trim();
                    let value = parts.join('=').trim().replace(/^["']|["']$/g, '');
                    
                    // 核心修复：如果是占位符则视为无效，避免被错误注入
                    if (value !== `\${${keyTrim}}`) {
                        config[keyTrim] = value;
                    }
                }
            });
        } catch (e) {
            console.warn('⚠️ 读取 .env 失败，降级使用环境变量');
        }
    }
    
    // 优先级：系统环境变量 (GHA 注入) > .env 文件
    return {
        accountId: process.env.CLOUDFLARE_D1_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || config.CLOUDFLARE_D1_ACCOUNT_ID || config.CF_ACCOUNT_ID,
        databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID || config.CLOUDFLARE_D1_DATABASE_ID,
        token: process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_KV_TOKEN || config.CLOUDFLARE_D1_TOKEN || config.CLOUDFLARE_KV_TOKEN
    };
}

async function runDiagnostics() {
    console.log('🔍 D1 详细诊断脚本');
    console.log('='.repeat(60));
    
    const config = loadEnvConfig();
    
    // 1. 配置检查
    console.log('\n📊 1. 配置检查:');
    console.log(`   CLOUDFLARE_D1_ACCOUNT_ID: ${config.accountId || 'MISSING'}`);
    console.log(`   CLOUDFLARE_D1_DATABASE_ID: ${config.databaseId || 'MISSING'}`);
    console.log(`   CLOUDFLARE_D1_TOKEN: ${config.token ? '***' + config.token.slice(-4) : 'MISSING'}`);
    
    if (!config.accountId || !config.databaseId || !config.token) {
        console.error('\n❌ 错误: 配置缺失，无法继续诊断。');
        process.exit(1);
    }
    console.log('✅ 配置完整');
    
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
    
    const queryD1 = async (sql, params = [], customToken = null) => {
        return await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${customToken || config.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sql, params })
        });
    };

    // 2. 基础连通性测试
    console.log('\n🌐 2. 基础连通性测试 (SELECT 1)...');
    try {
        const response = await queryD1('SELECT 1 as health');
        const result = await response.json();
        if (result.success && result.result?.[0]) {
            const meta = result.result[0].meta;
            console.log('✅ 基础连通性测试通过');
            console.log(`   Region: ${meta.served_by_region || 'N/A'}`);
            console.log(`   SQL Duration: ${meta.timings?.sql_duration_ms || 0}ms`);
        } else {
            console.error('❌ API 返回失败:', result.errors);
        }
    } catch (e) { console.error('❌ 请求异常:', e.message); }
    
    // 3. drives 表检查
    console.log('\n🗄️ 3. drives 表检查...');
    try {
        const response = await queryD1('SELECT COUNT(*) as count FROM drives');
        const result = await response.json();
        if (result.success && result.result?.[0]?.results?.[0]) {
            console.log(`✅ drives 表存在，记录数: ${result.result[0].results[0].count}`);
        } else {
            console.log(`❌ drives 表异常: ${result.errors?.[0]?.message}`);
        }
    } catch (e) { console.error('❌ 检查失败:', e.message); }

    // 4. 网络延迟测试
    console.log('\n⏱️ 4. 网络延迟测试 (3次采样)...');
    const latencies = [];
    for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await queryD1('SELECT 1').catch(() => {});
        latencies.push(Date.now() - start);
    }
    console.log(`   延时: ${latencies.join('ms, ')}ms`);

    // 5. 错误处理测试 (无效 Token)
    console.log('\n⚠️ 5. 错误处理测试 (无效 Token)...');
    try {
        const response = await queryD1('SELECT 1', [], 'invalid_token_test');
        const result = await response.json();
        if (!result.success) {
            console.log('✅ 错误处理正常');
            console.log(`   Error Code: ${result.errors[0].code}`);
            console.log(`   Error Message: ${result.errors[0].message}`);
        } else {
            console.error('❌ 未预期的成功响应');
        }
    } catch (e) { console.error('❌ 测试异常:', e.message); }
    
    // 6. 错误处理测试 (无效 SQL)
    console.log('\n⚠️ 6. SQL 语法错误测试...');
    try {
        const response = await queryD1('INVALID SQL SYNTAX');
        const result = await response.json();
        if (!result.success) {
            console.log('✅ SQL 错误处理正常');
            console.log(`   Error Code: ${result.errors[0].code}`);
            console.log(`   Error Message: ${result.errors[0].message}`);
        } else {
            console.error('❌ 未预期的成功响应');
        }
    } catch (e) { console.error('❌ 测试异常:', e.message); }
    
    console.log('\n' + '='.repeat(60));
    console.log('🔍 诊断完成');
}

runDiagnostics().catch(err => {
    console.error('致命错误:', err);
    process.exit(1);
});