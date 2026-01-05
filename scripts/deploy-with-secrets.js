#!/usr/bin/env node

/**
 * 使用 secret bulk 方式部署 Cloudflare Worker
 * 解决 --var 导致的 URL 截断和明文暴露问题
 * 支持本地调试环境下自动通过 Infisical 注入变量
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * 清理变量中的引号
 */
const cleanValue = (val) => {
    if (!val) return val;
    return val.replace(/^['"]|['"]$/g, '').trim();
};

/**
 * 从 manifest.json 提取需要作为 secret 的变量
 */
function getSecretsFromManifest() {
    const manifestPath = path.join(projectRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error('manifest.json not found');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const envConfig = manifest.config?.env || {};
    
    // 提取类型为 string 的配置项
    const secretKeys = Object.entries(envConfig)
        .filter(([_, config]) => config.type === 'string')
        .map(([key, _]) => key);
    
    return secretKeys;
}

/**
 * 从环境变量中提取 secrets，排除 infrastructure 变量
 */
function extractSecretsFromEnv(env = process.env) {
    const secretKeys = getSecretsFromManifest();
    const secrets = {};
    
    // 定义不需要作为 secret 上传的变量黑名单
    const blacklist = ['NODE_ENV', 'SIGNATURE_EXPIRATION_WINDOW'];
    
    for (const key of secretKeys) {
        if (blacklist.includes(key)) continue;
        
        const value = env[key];
        if (value !== undefined && value !== '') {
            let cleanVal = String(value).trim();
            // 清理冗余引号
            while (cleanVal.length > 1 && 
                   ((cleanVal.startsWith('"') && cleanVal.endsWith('"')) || 
                    (cleanVal.startsWith("'") && cleanVal.endsWith("'")))) {
                cleanVal = cleanVal.substring(1, cleanVal.length - 1);
            }
            
            if (cleanVal) {
                secrets[key] = cleanVal;
            }
        }
    }
    
    return secrets;
}

/**
 * 生成 secrets.json 文件
 */
function generateSecretsJson(secrets) {
    const secretsJsonPath = path.join(projectRoot, 'secrets.json');
    fs.writeFileSync(secretsJsonPath, JSON.stringify(secrets, null, 2));
    console.log(`✅ Generated secrets.json with ${Object.keys(secrets).length} secrets`);
    return secretsJsonPath;
}

/**
 * 脱敏敏感信息用于日志输出
 */
function redactSensitiveInfo(str) {
    if (!str) return str;
    const urlPattern = /(redis|rediss|postgres|mysql|mongodb):\/\/([^@]+@)?([^@]+)(:\d+)?/gi;
    return str.replace(urlPattern, (match, protocol, userPass, host, port) => {
        if (userPass && userPass.includes(':')) {
            return `${protocol}://***REDACTED***@${host}${port || ''}`;
        }
        return match;
    });
}

/**
 * 执行 wrangler secret bulk 命令
 */
function uploadSecrets(secretsJsonPath) {
    console.log('🚀 Uploading secrets to Cloudflare Workers...');
    
    try {
        const command = `npx wrangler secret bulk ${secretsJsonPath}`;
        console.log('Command:', redactSensitiveInfo(command));
        
        execSync(command, {
            stdio: 'inherit',
            env: { ...process.env }
        });
        
        console.log('✅ Secrets uploaded successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to upload secrets:', error.message);
        return false;
    }
}

/**
 * 执行 wrangler deploy 命令
 */
function deployWorker() {
    console.log('🚀 Deploying worker...');
    
    try {
        const command = 'npx wrangler deploy -c wrangler.toml --compatibility-flags="nodejs_compat"';
        console.log('Command:', command);
        
        execSync(command, {
            stdio: 'inherit',
            env: { ...process.env }
        });
        
        console.log('✅ Worker deployed successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to deploy worker:', error.message);
        return false;
    }
}

/**
 * 本地调试环境自动化：检测并自动注入 Infisical 变量
 */
function ensureInfisicalInjection() {
    // 如果已经由 infisical 启动，或者明确跳过自动化，则直接返回
    if (process.env.INFISICAL_ENV_INJECTED === 'true' || process.env.SKIP_INFISICAL_AUTO === 'true') {
        return false;
    }

    // 检查是否存在 .act.secrets
    const actSecretsPath = path.join(projectRoot, '.act.secrets');
    if (!fs.existsSync(actSecretsPath)) {
        return false;
    }

    console.log('🛠️ Local debug mode detected, attempting Infisical injection...');
    
    // 加载配置
    const envConfig = dotenv.parse(fs.readFileSync(actSecretsPath));
    const projectId = cleanValue(envConfig.INFISICAL_PROJECT_ID);
    const token = cleanValue(envConfig.INFISICAL_TOKEN);

    if (!projectId) {
        console.warn('⚠️ INFISICAL_PROJECT_ID not found in .act.secrets, skipping auto-injection');
        return false;
    }

    console.log(`🚀 Relaunching with Infisical (Project: ${projectId})`);
    
    // 设置注入标记，防止死循环
    const newEnv = { ...process.env, ...envConfig };
    newEnv.INFISICAL_ENV_INJECTED = 'true';
    if (token) newEnv.INFISICAL_TOKEN = token;

    const args = [
        'run',
        '--env=dev',
        `--projectId=${projectId}`,
        '--',
        'node',
        fileURLToPath(import.meta.url)
    ];

    const child = spawn('infisical', args, {
        stdio: 'inherit',
        shell: false,
        env: newEnv
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });

    return true; // 表示已经启动了子进程
}

/**
 * 主函数
 */
function main() {
    // 本地自动化检查
    if (ensureInfisicalInjection()) {
        return;
    }

    try {
        console.log('=== Cloudflare Worker Deployment with Secrets ===\n');
        
        const secrets = extractSecretsFromEnv();
        
        if (Object.keys(secrets).length === 0) {
            console.warn('⚠️ No secrets found in environment variables');
            console.warn('Proceeding with deployment without secrets upload...');
        } else {
            console.log(`   Found ${Object.keys(secrets).length} secrets:`, 
                Object.keys(secrets).join(', '));
        }
        
        let secretsJsonPath = null;
        if (Object.keys(secrets).length > 0) {
            console.log('\n2. Generating secrets.json...');
            secretsJsonPath = generateSecretsJson(secrets);
        }
        
        if (secretsJsonPath) {
            console.log('\n3. Uploading secrets to Cloudflare...');
            const success = uploadSecrets(secretsJsonPath);
            if (!success) {
                console.error('Secret upload failed, aborting deployment');
                if (fs.existsSync(secretsJsonPath)) fs.unlinkSync(secretsJsonPath);
                process.exit(1);
            }
            
            fs.unlinkSync(secretsJsonPath);
            console.log('   Cleaned up temporary secrets.json');
        }
        
        console.log('\n4. Deploying worker...');
        const success = deployWorker();
        
        if (success) {
            console.log('\n🎉 Deployment completed successfully!');
            console.log('   - Secrets uploaded as encrypted variables');
            console.log('   - Worker deployed with latest code');
        } else {
            console.error('\n❌ Deployment failed');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('\n❌ Deployment failed:', error.message);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}

export { extractSecretsFromEnv, generateSecretsJson, uploadSecrets, deployWorker };
