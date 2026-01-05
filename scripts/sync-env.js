#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InfisicalSDK } from '@infisical/sdk';
import { mapNodeEnvToInfisicalEnv } from '../src/utils/envMapper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envFilePath = path.join(projectRoot, '.env');

// 辅助函数：读取 .env 文件
function readEnvFile() {
    if (!fs.existsSync(envFilePath)) return {};
    const content = fs.readFileSync(envFilePath, 'utf8');
    const env = {};
    content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const [key, ...valueParts] = trimmed.split('=');
            env[key.trim()] = valueParts.join('=').trim();
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

// 主函数
async function main() {
    try {
        console.log('🚀 开始同步 Infisical 环境变量...');

        const nodeEnv = process.env.NODE_ENV || 'development';
        const infisicalEnvName = mapNodeEnvToInfisicalEnv(nodeEnv);

        if (nodeEnv === 'production') {
            console.log('⚠️ 生产环境跳过 .env 文件同步，依赖运行时动态获取。');
            return;
        }

        const token = process.env.INFISICAL_TOKEN;
        const projectId = process.env.INFISICAL_PROJECT_ID;

        if (!token || !projectId) {
            console.error('❌ 错误: 未提供 INFISICAL_TOKEN 或 INFISICAL_PROJECT_ID 环境变量。无法进行本地开发环境同步。');
            process.exit(1);
        }

        console.log(`📡 尝试通过 Infisical SDK 获取 ${infisicalEnvName} 环境的秘密...`);
        const client = new InfisicalSDK({
            token: token,
            siteURL: 'https://app.infisical.com' // 根据你的 Infisical 实例进行调整
        });

        const secrets = await client.getAllSecrets({
            environment: infisicalEnvName,
            projectSlug: projectId,
            path: '/'
        });

        if (secrets && secrets.length > 0) {
            const envVars = {};
            secrets.forEach(s => {
                envVars[s.secretKey] = s.secretValue;
            });
            writeEnvFile(envVars);
            console.log('✅ 环境变量同步完成');
        } else {
            console.log('⚠️ 未从 Infisical 获取到任何秘密。');
        }

    } catch (error) {
        console.error('❌ 同步失败:', error.message);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}