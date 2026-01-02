#!/usr/bin/env node

/**
 * D1 简化诊断脚本 (独立增强版)
 * 不依赖项目源码，支持 .env 解析与占位符过滤
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// 健壮的配置加载：支持 .env + 环境变量 + 占位符过滤
function loadConfig() {
    const config = {
        accountId: process.env.CF_D1_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
        databaseId: process.env.CF_D1_DATABASE_ID,
        token: process.env.CF_D1_TOKEN || process.env.CF_KV_TOKEN
    };

    // 如果环境变量缺失，尝试解析本地 .env
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [key, ...parts] = trimmed.split('=');
                const k = key.trim();
                let v = parts.join('=').trim().replace(/^["']|["']$/g, '');
                
                // 仅在当前没值且不是占位符时赋值
                if (!config[k === 'CF_ACCOUNT_ID' || k === 'CF_D1_ACCOUNT_ID' ? 'accountId' : 
                            k === 'CF_D1_DATABASE_ID' ? 'databaseId' : 
                            k === 'CF_D1_TOKEN' || k === 'CF_KV_TOKEN' ? 'token' : 'none'] && v !== `\${${k}}`) {
                    if (k === 'CF_ACCOUNT_ID' || k === 'CF_D1_ACCOUNT_ID') config.accountId = v;
                    if (k === 'CF_D1_DATABASE_ID') config.databaseId = v;
                    if (k === 'CF_D1_TOKEN' || k === 'CF_KV_TOKEN') config.token = v;
                }
            }
        });
    }

    // 最后的占位符清洗：防止 process.env 里残留了未替换的 ${VAR}
    for (const key in config) {
        if (config[key] && config[key].startsWith('${')) config[key] = null;
    }

    return config;
}

async function testD1Connection() {
    console.log('🔍 D1 增强诊断脚本');
    console.log('='.repeat(50));
    
    const config = loadConfig();
    
    // 1. 检查配置
    console.log('\n1. 配置检查:');
    if (!config.accountId || !config.databaseId || !config.token) {
        console.error('❌ 配置缺失');
        console.log(`   Account ID: ${config.accountId ? 'OK' : 'MISSING'}`);
        console.log(`   Database ID: ${config.databaseId ? 'OK' : 'MISSING'}`);
        console.log(`   Token: ${config.token ? 'OK' : 'MISSING'}`);
        return false;
    }
    console.log('✅ 配置完整');
    
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
    
    const d1Fetch = (sql, params = [], token = config.token) => fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sql, params })
    });

    // 2. 健康检查
    console.log('\n2. 连通性检查 (SELECT 1)...');
    try {
        const response = await d1Fetch('SELECT 1 as health');
        if (!response.ok) {
            const err = await response.json();
            console.error(`❌ HTTP ${response.status}:`, err.errors || response.statusText);
            return false;
        }
        console.log('✅ API 连通性 OK');
    } catch (error) {
        console.error('❌ API 请求失败:', error.message);
        return false;
    }
    
    // 3. 检查 drives 表
    console.log('\n3. 表结构检查 (drives)...');
    try {
        const response = await d1Fetch('SELECT COUNT(*) as count FROM drives');
        const result = await response.json();
        if (result.success && result.result?.[0]) {
            const count = result.result[0].results[0].count;
            console.log(`✅ drives 表 OK, 记录数: ${count}`);
        } else {
            console.error('❌ drives 表问题:', result.errors);
        }
    } catch (error) {
        console.error('❌ drives 表检查失败:', error.message);
    }
    
    // 4. 模拟业务查询
    console.log('\n4. 模拟业务查询 (findByUserId)...');
    try {
        const response = await d1Fetch(
            'SELECT id, name FROM drives WHERE user_id = ? AND status = ? LIMIT 1',
            ['diag-user', 'active']
        );
        const result = await response.json();
        if (result.success) {
            console.log('✅ 业务查询语法校验通过');
        } else {
            console.error('❌ 查询语法错误:', result.errors);
        }
    } catch (error) {
        console.error('❌ 示例查询失败:', error.message);
    }
    
    // 5. 测试错误场景
    console.log('\n5. 错误处理测试 (无效 Token)...');
    try {
        const response = await d1Fetch('SELECT 1', [], 'invalid_token_test');
        const result = await response.json();
        if (!result.success) {
            console.log(`✅ 成功捕获预期错误: ${result.errors[0].message}`);
        }
    } catch (error) {
        console.error('❌ 错误测试异常:', error.message);
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('🔍 诊断完成');
    return true;
}

testD1Connection().catch(err => {
    console.error('致命错误:', err);
    process.exit(1);
});