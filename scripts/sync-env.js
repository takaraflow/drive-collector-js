#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InfisicalSDK } from '@infisical/sdk';
import dotenv from 'dotenv';
import { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } from '../src/utils/envMapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 根据 NODE_ENV 加载对应的 .env 文件
const nodeEnvForFile = normalizeNodeEnv(process.env.NODE_ENV);
const envFile = nodeEnvForFile === 'dev' ? '.env' : `.env.${nodeEnvForFile}`;
const envPath = path.join(rootDir, envFile);

// 加载现有 .env (如果存在) 用于降级检查
dotenv.config({ path: envPath, override: true });

const manifestPath = path.join(rootDir, 'manifest.json');

// 获取配置
const STRICT_SYNC = process.env.STRICT_SYNC === '1' || process.env.STRICT_SYNC === 'true';
const WRITE_ENV_FILE = process.env.SYNC_ENV_WRITE_FILE === '1' || process.env.SYNC_ENV_WRITE_FILE === 'true';
const SECRET_PATH = process.env.INFISICAL_SECRET_PATH || '/';

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

export async function syncEnv() {
    console.log(`🚀 开始同步 Infisical 环境变量... (模式: ${STRICT_SYNC ? '严格' : '非严格'}, 写入文件: ${WRITE_ENV_FILE ? '启用' : '禁用'})`);

    const token = process.env.INFISICAL_TOKEN;
    const projectId = process.env.INFISICAL_PROJECT_ID;

    // 支持动态环境：优先使用 INFISICAL_ENV，其次 NODE_ENV，默认 'dev'
    const nodeEnv = process.env.INFISICAL_ENV || process.env.NODE_ENV || 'dev';
    const normalizedEnv = normalizeNodeEnv(nodeEnv);
    const infisicalEnv = mapNodeEnvToInfisicalEnv(normalizedEnv);

    console.log(`[Sync-Env] 检测到环境: ${nodeEnv} -> ${normalizedEnv} -> Infisical环境: ${infisicalEnv}`);

    let infisicalSynced = false;

    // 尝试从 Infisical 拉取
    if (token && projectId) {
        try {
            console.log('🔄 初始化 Infisical SDK...');
            const sdk = new InfisicalSDK({ siteUrl: 'https://app.infisical.com' });
            
            console.log('🔑 进行认证...');
            sdk.auth().accessToken(token);

            console.log('📡 正在从 Infisical 拉取配置 (SDK v4)...');

            const response = await sdk.secrets().listSecrets({
                environment: infisicalEnv,
                projectId: projectId,
                secretPath: SECRET_PATH,
                includeImports: true
            });
 
            if (response && response.secrets) {
                const secrets = response.secrets;
                console.log(`✅ 成功拉取 ${secrets.length} 个变量`);

                // 转换 secrets 为键值对对象用于验证
                const secretsMap = {};
                const envLines = [];
                
                // 排序并构建内容
                const sortedSecrets = secrets.sort((a, b) => a.secretKey.localeCompare(b.secretKey));
                for (const secret of sortedSecrets) {
                    secretsMap[secret.secretKey] = secret.secretValue;
                    if (WRITE_ENV_FILE) {
                        envLines.push(`${secret.secretKey}=${secret.secretValue}`);
                    }
                }

                // 验证
                if (validateVariables(secretsMap, 'Infisical')) {
                    for (const [key, value] of Object.entries(secretsMap)) {
                        process.env[key] = value;
                    }
                    if (WRITE_ENV_FILE) {
                        fs.writeFileSync(envPath, `${envLines.join('\n')}\n`, { mode: 0o600 });
                        console.log(`✅ 已更新 .env 文件`);
                    } else {
                        console.log('✅ 已加载 Infisical 变量到当前进程，未写入 .env 文件');
                    }
                    infisicalSynced = true;
                } else {
                    if (STRICT_SYNC) process.exit(1);
                }
            }
        } catch (error) {
            console.error(`❌ Infisical 同步失败: ${error.message}`);
            // 如果是非严格模式，允许失败继续（进入降级逻辑）
            if (STRICT_SYNC) {
                console.error('❌ 严格模式下 Infisical 同步失败是致命错误');
                process.exit(1);
            }
        }
    } else {
        console.warn('⚠️  未设置 INFISICAL_TOKEN 或 INFISICAL_PROJECT_ID，跳过远程同步');
        if (STRICT_SYNC) {
            console.error('❌ 严格模式下必须提供 Infisical 凭证');
            process.exit(1);
        }
    }

    if (infisicalSynced) {
        console.log('✅ 使用 Infisical 变量继续');
        return;
    }

    // 降级逻辑: 检查本地缓存或系统变量
    console.log('🔄 进入降级检查...');
    
    // 检查现有 .env
    if (fs.existsSync(envPath)) {
        console.log('📄 检查本地 .env 文件...');
        const currentEnv = dotenv.parse(fs.readFileSync(envPath));
        if (validateVariables(currentEnv, '本地 .env')) {
            console.log('✅ 使用本地 .env 缓存继续');
            return; // 成功，正常返回，让 node 进程自然退出
        }
    }

    // 检查系统环境变量
    console.log('🔍 检查系统环境变量...');
    if (validateVariables(process.env, '系统环境变量')) {
        console.log('✅ 系统环境变量满足要求');
        return; // 成功，正常返回
    }

    console.error('❌ 无法满足最小配置要求');
    process.exit(1);
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
const scriptPath = fileURLToPath(import.meta.url);

if (entryPoint === scriptPath) {
    syncEnv().catch(err => {
        console.error('❌ 脚本执行异常:', err);
        process.exit(1);
    });
}
