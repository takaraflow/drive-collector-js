#!/usr/bin/env node

/**
 * 使用 secret bulk 方式部署 Cloudflare Worker
 * 解决 --var 导致的 URL 截断和明文暴露问题
 * 集成 orchestrated secrets 系统，支持 Infisical 自动注入变量
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import { loadEnvFile, normalizeEnvName, hasInfisicalCredentials, hasDopplerCredentials, hasOrchestratedSecrets } from './build-utils.js';
import { SecretsOrchestrator } from '../src/config/SecretsOrchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function sleepMs(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // busy-wait (script-only)
    }
}

function resolveNpxCommand() {
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function resolveWranglerArgsPrefix() {
    const pinned = String(process.env.WRANGLER_VERSION || '').trim();
    if (!pinned) return ['wrangler'];

    // `-y` avoids interactive prompt in CI when a package install is needed.
    return ['-y', `wrangler@${pinned}`];
}

function printWranglerLogTail(combinedOutput) {
    const match = /Logs were written to \"([^\"]+)\"/.exec(combinedOutput || '');
    const logPath = match?.[1];
    if (!logPath) return;

    try {
        if (!fs.existsSync(logPath)) return;
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split(/\r?\n/);
        const tail = lines.slice(Math.max(0, lines.length - 120)).join('\n');
        console.error(`\n--- Wrangler log tail: ${logPath} ---\n${tail}\n--- end ---\n`);
    } catch (e) {
        console.error(`(Failed to read Wrangler log: ${logPath})`, e?.message || e);
    }
}

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
    // 避免与已存在的纯文本 Vars 绑定冲突（Cloudflare 不允许同名 secret + var），支持通过环境变量配置
    const skipKeysRaw = env.SECRET_SKIP_KEYS || env.SECRET_CONFLICT_KEYS || '';
    const conflictSkipList = new Set(skipKeysRaw.split(',').map(k => k.trim()).filter(Boolean));
    
    for (const key of secretKeys) {
        if (blacklist.includes(key)) continue;
        if (conflictSkipList.has(key)) {
            console.warn(`Skipping secret ${key} to avoid binding conflict; expected to be provided as plain var in Cloudflare.`);
            continue;
        }
        
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
    console.log('🚀 正在上传 Secrets 到 Cloudflare (Uploading secrets)...');
    
    const args = [...resolveWranglerArgsPrefix(), 'secret', 'bulk', secretsJsonPath];
    const npxCommand = resolveNpxCommand();
    const command = `${npxCommand} ${args.map(part => part.includes(' ') ? `"${part}"` : part).join(' ')}`;
    console.log('Command:', redactSensitiveInfo(command));

    const result = spawnSync(npxCommand, args, {
        env: { ...process.env, WRANGLER_LOG_LEVEL: process.env.WRANGLER_LOG_LEVEL || 'debug' },
        encoding: 'utf8',
        shell: process.platform === 'win32'
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.status === 0) {
        console.log('✅ Secrets 上传成功 (Secrets uploaded successfully)');
        return { ok: true };
    }

    const combined = [result.stdout || '', result.stderr || '', result.error?.message || '']
        .join('\n')
        .trim();
    console.error('❌ Failed to upload secrets:', combined || 'Unknown error');
    printWranglerLogTail(combined);
    return { ok: false, errorText: combined || 'Unknown error' };
}

function handleSecretsUpload(initialSecrets) {
    let secrets = { ...initialSecrets };
    let attempt = 0;
    const maxAttempts = Math.max(1, Object.keys(secrets).length + 1);
    let networkRetries = 0;

    while (attempt < maxAttempts) {
        if (Object.keys(secrets).length === 0) {
            console.warn('No secrets left to upload after resolving conflicts.');
            return true; // nothing to upload, but not a hard failure
        }

        console.log('\n2. Generating secrets.json...');
        const secretsJsonPath = generateSecretsJson(secrets);

        console.log('\n3. Uploading secrets to Cloudflare...');
        const result = uploadSecrets(secretsJsonPath);

        if (fs.existsSync(secretsJsonPath)) {
            fs.unlinkSync(secretsJsonPath);
            console.log('   Cleaned up temporary secrets.json');
        }

        if (result.ok) {
            return true;
        }

        // Retry transient network failures (common in CI containers)
        if ((result.errorText || '').includes('fetch failed') && networkRetries < 3) {
            const delayMs = Math.min(8000, Math.pow(2, networkRetries) * 1000);
            networkRetries += 1;
            console.warn(`Detected network error (fetch failed). Retrying in ${delayMs}ms... (attempt ${networkRetries}/3)`);
            sleepMs(delayMs);
            continue;
        }

        const conflictMatch = /Binding name ['"]?([A-Z0-9_]+)['"]? already in use/i.exec(result.errorText || '');
        if (conflictMatch) {
            const conflictedKey = conflictMatch[1];
            if (secrets[conflictedKey] !== undefined) {
                console.warn(`Detected binding conflict for ${conflictedKey}; removing from secrets and retrying...`);
                delete secrets[conflictedKey];
                attempt += 1;
                continue;
            }
        }

        return false;
    }

    console.error('Reached maximum retry attempts for secrets upload.');
    return false;
}

/**
 * 执行 wrangler deploy 命令
 */
function deployWorker() {
    console.log('🚀 Deploying worker...');
    
    try {
        const npxCommand = resolveNpxCommand();
        const args = [
            ...resolveWranglerArgsPrefix(),
            'deploy',
            '-c',
            'wrangler.toml',
            '--compatibility-flags="nodejs_compat"'
        ];
        const command = `${npxCommand} ${args.join(' ')}`;
        console.log('Command:', command);
        
        execSync(command, {
            stdio: 'inherit',
            env: { ...process.env, WRANGLER_LOG_LEVEL: process.env.WRANGLER_LOG_LEVEL || 'debug' }
        });
        
        console.log('✅ Worker deployed successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to deploy worker:', error.message);
        return false;
    }
}

/**
 * 本地调试环境自动化：检测并使用新的 orchestrated secrets 系统
 */
function ensureInfisicalInjection() {
    // 如果已经由 orchestrated 系统启动，或者明确跳过自动化，则直接返回
    if (process.env.ORCHESTRATED_SECRETS_USED === 'true' || process.env.SKIP_INFISICAL_AUTO === 'true') {
        return false;
    }

    // 检查是否存在 Infisical 凭据
    if (!hasInfisicalCredentials()) {
        return false;
    }

    console.log('🔐 Local debug mode detected, using orchestrated secrets system...');
    
    // 标记已使用 orchestrated 系统
    process.env.ORCHESTRATED_SECRETS_USED = 'true';
    process.env.USE_ORCHESTRATED_SECRETS = 'true';
    
    return false; // 不需要启动子进程，继续当前流程
}

function applyDotenvFallback() {
    const runtimeEnv = process.env.RUNTIME_ENV || process.env.DEPLOY_ENV || process.env.NODE_ENV || 'dev';
    const normalizedEnv = normalizeEnvName(runtimeEnv);
    const shouldOverride = !hasInfisicalCredentials() && !hasOrchestratedSecrets();

    if (shouldOverride) {
        console.log('?? 未检测到 Infisical/orchestrated 信息，使用 .env 文件作为部署阶段的降级配置');
    }

    loadEnvFile(fs, normalizedEnv, { overrideExisting: shouldOverride });
}

/**
 * Enhanced secrets injection using the orchestration system
 */
async function executeOrchestratedSecretsInjection(environment) {
    console.log('🔐 Starting enhanced secrets injection...');
    
    const orchestrator = new SecretsOrchestrator({
        environment,
        provider: 'infisical',
        providerConfig: {
            projectId: process.env.INFISICAL_PROJECT_ID,
            token: process.env.INFISICAL_TOKEN,
            siteURL: process.env.INFISICAL_SITE_URL
        },
        validate: true,
        dryRun: false,
        cleanup: false // Don't cleanup yet, we need the files for deployment
    });
    
    try {
        const result = await orchestrator.executeInjection();
        
        if (!result.success) {
            console.error('❌ Enhanced secrets injection failed:', result.error);
            // Fall back to legacy method if orchestrated injection fails
            console.warn('⚠️ Falling back to legacy secrets extraction...');
            return null;
        }
        
        console.log('✅ Enhanced secrets injection completed successfully');
        console.log(`   - Secrets fetched: ${result.secrets.size}`);
        console.log(`   - Files generated: ${result.generatedFiles.length}`);
        
        // Return the secrets.json path for upload
        const secretsJsonPath = result.generatedFiles.find(file => file.endsWith('secrets.json'));
        if (secretsJsonPath) {
            console.log(`   - Secrets file: ${secretsJsonPath}`);
        }
        
        return { secretsJsonPath, secrets: result.secrets };
        
    } catch (error) {
        console.error('❌ Critical error during orchestrated secrets injection:', error.message);
        return null;
    } finally {
        await orchestrator.cleanup();
    }
}

/**
 * 主函数
 */
async function main() {
    // 本地自动化检查
    if (ensureInfisicalInjection()) {
        return;
    }
    applyDotenvFallback();

    try {
        console.log('=== Cloudflare Worker Deployment with Enhanced Secrets Management ===\n');
        
        // Try orchestrated secrets injection first
        const environment = process.env.RUNTIME_ENV || process.env.DEPLOY_ENV || process.env.NODE_ENV || 'dev';
        let secrets = null;
        let orchestratedResult = null;
        
        if ((hasInfisicalCredentials() || hasDopplerCredentials()) && hasOrchestratedSecrets()) {
            orchestratedResult = await executeOrchestratedSecretsInjection(environment);
        }
        
        // Fallback to legacy method if orchestration fails or is disabled
        if (orchestratedResult) {
            secrets = orchestratedResult.secrets;
        } else {
            secrets = new Map();
            const legacySecrets = extractSecretsFromEnv();
            for (const [key, value] of Object.entries(legacySecrets)) {
                secrets.set(key, value);
            }
        }
        
        if (secrets.size === 0) {
            console.warn('⚠️ No secrets found in environment variables');
            console.warn('Proceeding with deployment without secrets upload...');
        } else {
            console.log(`   Found ${secrets.size} secrets:`, 
                Array.from(secrets.keys()).join(', '));
        }
        
        let uploadSuccess = true;
        
        // Handle secrets upload differently based on whether we used orchestrated injection
        if (orchestratedResult && orchestratedResult.secretsJsonPath) {
            // Use the generated secrets.json file
            uploadSuccess = handleSecretsUpload(
                Object.fromEntries(secrets)
            );
        } else {
            // Use legacy method
            uploadSuccess = handleSecretsUpload(
                Object.fromEntries(secrets)
            );
        }
        if (!uploadSuccess) {
            if (String(process.env.ALLOW_SECRET_UPLOAD_FAILURE || '').toLowerCase() === 'true') {
                console.warn('⚠️ Secret upload failed, but ALLOW_SECRET_UPLOAD_FAILURE=true so continuing to deploy...');
            } else {
                console.error('Secret upload failed, aborting deployment');
                process.exit(1);
            }
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
