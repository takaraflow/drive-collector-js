#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InfisicalSDK } from '@infisical/sdk';
import dotenv from 'dotenv';

// 加载现有 .env (如果存在) 用于降级检查
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'manifest.json');
const envPath = path.join(rootDir, '.env');

// 获取配置
const STRICT_SYNC = process.env.STRICT_SYNC === '1' || process.env.STRICT_SYNC === 'true';

// 1. 从 manifest.json 读取必需变量
function getRequiredKeys() {
    try {
        if (!fs.existsSync(manifestPath)) {
            console.warn('⚠️  警告: 未找到 manifest.json，跳过必需变量检查');
            return [];
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const envConfig = manifest.config?.env || {};
        
        return Object.entries(envConfig)
            .filter(([_, config]) => config.required === true)
            .map(([key]) => key);
    } catch (error) {
        console.warn(`⚠️  无法读取 manifest.json: ${error.message}`);
        return [];
    }
}

// 2. 检查变量完整性
function validateVariables(variables, sourceName) {
    const requiredKeys = getRequiredKeys();
    const missingKeys = requiredKeys.filter(key => !variables[key] && !process.env[key]); // 检查变量集合和系统环境

    if (missingKeys.length > 0) {
        if (STRICT_SYNC) {
            console.error(`❌ [严格模式] ${sourceName} 缺少必需变量:`);
            missingKeys.forEach(key => console.error(`   - ${key}`));
            return false;
        } else {
            console.warn(`⚠️  [非严格模式] ${sourceName} 缺少以下变量 (可能已在系统环境中配置):`);
            missingKeys.forEach(key => console.warn(`   - ${key}`));
            return true; // 非严格模式允许缺失，假设系统环境或其他地方有兜底
        }
    }
    return true;
}

async function syncEnv() {
    console.log(`🚀 开始同步 Infisical 环境变量... (模式: ${STRICT_SYNC ? '严格' : '非严格'})`);

    const token = process.env.INFISICAL_TOKEN;
    const projectId = process.env.INFISICAL_PROJECT_ID;

    // 尝试从 Infisical 拉取
    if (token && projectId) {
        try {
            console.log('🔄 初始化 Infisical SDK...');
            const sdk = new InfisicalSDK({ siteUrl: 'https://app.infisical.com' });
            
            console.log('🔑 进行认证...');
            sdk.auth().accessToken(token);

            console.log('📡 正在从 Infisical 拉取配置 (SDK v4)...');
            
            const response = await sdk.secrets().listSecrets({
                environment: 'prod',
                projectId: projectId,
                secretPath: '/',
                includeImports: true
            });

            if (response && response.secrets) {
                const secrets = response.secrets;
                console.log(`✅ 成功拉取 ${secrets.length} 个变量`);

                // 转换 secrets 为键值对对象用于验证
                const secretsMap = {};
                let envContent = '';
                
                // 排序并构建内容
                const sortedSecrets = secrets.sort((a, b) => a.secretKey.localeCompare(b.secretKey));
                for (const secret of sortedSecrets) {
                    secretsMap[secret.secretKey] = secret.secretValue;
                    envContent += `${secret.secretKey}=${secret.secretValue}\n`;
                }

                // 验证
                if (validateVariables(secretsMap, 'Infisical')) {
                    fs.writeFileSync(envPath, envContent);
                    console.log(`✅ 已更新 .env 文件`);
                    process.exit(0);
                } else {
                    if (STRICT_SYNC) process.exit(1);
                }
            }
        } catch (error) {
            console.error(`❌ Infisical 同步失败: ${error.message}`);
            if (STRICT_SYNC) process.exit(1);
        }
    } else {
        console.warn('⚠️  未设置 INFISICAL_TOKEN 或 INFISICAL_PROJECT_ID，跳过远程同步');
        if (STRICT_SYNC) {
            console.error('❌ 严格模式下必须提供 Infisical 凭证');
            process.exit(1);
        }
    }

    // 降级逻辑: 检查本地缓存或系统变量
    console.log('🔄 进入降级检查...');
    
    // 检查现有 .env
    if (fs.existsSync(envPath)) {
        console.log('Dg  检查本地 .env 文件...');
        const currentEnv = dotenv.parse(fs.readFileSync(envPath));
        if (validateVariables(currentEnv, '本地 .env')) {
            console.log('✅ 使用本地 .env 缓存继续');
            process.exit(0);
        }
    }

    // 检查系统环境变量
    console.log('🔍 检查系统环境变量...');
    if (validateVariables(process.env, '系统环境变量')) {
        console.log('✅ 系统环境变量满足要求');
        process.exit(0);
    }

    console.error('❌ 无法满足最小配置要求');
    process.exit(1);
}

syncEnv();
