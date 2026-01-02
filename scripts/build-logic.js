#!/usr/bin/env node

/**
 * 跨平台的构建逻辑脚本
 * 替代 build.sh 中的 shell 脚本逻辑，确保在 GHA Linux 和 Windows 环境下都能正常工作
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// 从 .env 文件加载环境变量
function loadEnvFile(fileSystem = fs) {
    const envPath = path.join(projectRoot, '.env');
    if (fileSystem.existsSync(envPath)) {
        const envContent = fileSystem.readFileSync(envPath, 'utf8');
        const lines = envContent.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [key, ...valueParts] = trimmed.split('=');
                let value = valueParts.join('=');
                
                // 处理行尾注释：需要考虑引号内的 # 不被当作注释开始
                let inQuotes = false;
                let quoteChar = null;
                let commentStart = -1;
                
                for (let i = 0; i < value.length; i++) {
                    const char = value[i];
                    
                    if ((char === '"' || char === "'") && (i === 0 || value[i-1] !== '\\')) {
                        if (!inQuotes) {
                            inQuotes = true;
                            quoteChar = char;
                        } else if (char === quoteChar) {
                            inQuotes = false;
                            quoteChar = null;
                        }
                    } else if (char === '#' && !inQuotes) {
                        commentStart = i;
                        break;
                    }
                }
                
                // 移除注释部分
                if (commentStart !== -1) {
                    value = value.substring(0, commentStart);
                }
                
                // 去除首尾空格和包围引号
                value = value.trim().replace(/^["']|["']$/g, '');
                
                const keyTrim = key.trim();
                const currentVal = process.env[keyTrim];
                // 只有当环境变量不存在，或者是 ${VAR} 这种占位符时，才从 .env 加载
                if (!currentVal || currentVal === `\${${keyTrim}}`) {
                    process.env[keyTrim] = value;
                }
            }
        }
    }
}

// 检查必需的敏感变量
function checkRequiredVariables() {
    console.log('检查环境变量配置...');
    
    const checks = [
        { name: 'AXIOM_TOKEN', warning: 'AXIOM_TOKEN 未设置，请确保在生产环境中配置此变量' },
        { name: 'QSTASH_CURRENT_SIGNING_KEY', warning: 'QSTASH_CURRENT_SIGNING_KEY 未设置，如果需要 Webhook 签名验证，请确保配置此变量' },
        { name: 'UPSTASH_REDIS_REST_TOKEN', warning: 'UPSTASH_REDIS_REST_TOKEN 未设置，如果需要故障转移到 Upstash Redis，请确保配置此变量' },
        { name: 'UPSTASH_REDIS_REST_URL', warning: 'UPSTASH_REDIS_REST_URL 未设置，如果需要故障转移到 Upstash Redis，请确保配置此变量' },
        { name: 'AXIOM_ORG_ID', warning: 'AXIOM_ORG_ID 未设置，日志功能可能受限' }
    ];
    
    for (const check of checks) {
        const value = process.env[check.name];
        if (!value || value === `\${${check.name}}`) {
            console.log(`警告: ${check.warning}`);
        }
    }
}

// 从 manifest.json 动态提取环境变量
function extractVariablesFromManifest() {
    console.log('使用 Node.js 从 manifest.json 动态提取环境变量...');
    
    const manifestPath = path.join(projectRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('错误: 未找到 manifest.json');
        process.exit(1);
    }
    
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const envConfig = manifest.config?.env || {};
    
    // 提取类型为 string, number, boolean 的配置项键名
    const vars = Object.entries(envConfig)
        .filter(([_, config]) => ['string', 'number', 'boolean'].includes(config.type))
        .map(([key, _]) => key);
    
    // 手动添加不在 manifest.json config.env 中的关键部署变量
    const infraVars = ['WORKER_NAME', 'CLOUDFLARE_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'KV_PREVIEW_ID'];
    const allVars = [...vars, ...infraVars];
    
    // 清理可能误传为占位符字符串的变量，并设置默认值
    for (const varName of allVars) {
        // 如果变量值等于其占位符形式，则清空该变量
        if (!process.env[varName] || process.env[varName] === `\${${varName}}`) {
            delete process.env[varName];
        }
        
        // 尝试从 manifest.json 获取默认值
        const defaultValue = envConfig[varName]?.default || '';
        
        // 优先级：环境变量 > Manifest 默认值 > 空字符串
        if (!process.env[varName] && defaultValue) {
            process.env[varName] = defaultValue;
        }
    }
    
    // 特殊默认值设置
    // 从 package.json 提取 name 作为 WORKER_NAME 的默认值
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    
    if (!process.env.WORKER_NAME) {
        process.env.WORKER_NAME = pkg.name;
    }
    
    if (!process.env.AXIOM_DATASET) {
        process.env.AXIOM_DATASET = 'drive-collector';
    }
    
    if (!process.env.NODE_ENV) {
        process.env.NODE_ENV = 'production';
    }
    
    if (!process.env.SIGNATURE_EXPIRATION_WINDOW) {
        process.env.SIGNATURE_EXPIRATION_WINDOW = '900';
    }
    
    // 根据 WRANGLER_MODE 设置 CLOUDFLARE_ACCOUNT_ID
    if (process.env.WRANGLER_MODE === 'local') {
        process.env.CLOUDFLARE_ACCOUNT_ID = 'unused-in-local-dev';
    } else if (process.env.WRANGLER_MODE === 'remote') {
        if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
            console.error('错误: 远程开发模式需要 CLOUDFLARE_ACCOUNT_ID');
            console.error('请在 .env 文件中设置此变量');
            process.exit(1);
        }
    }
    
    // 检查是否在 GitHub Actions 环境中
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log('检测到 GitHub Actions 环境...');
        
        if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
            console.error('错误: GHA 环境下需要 CLOUDFLARE_ACCOUNT_ID');
            process.exit(1);
        }
        
        if (!process.env.CF_KV_NAMESPACE_ID) {
            console.log('警告: GHA 环境下 CF_KV_NAMESPACE_ID 为空，KV 绑定可能失效');
            if (process.env.NODE_ENV === 'production') {
                console.error('错误: 生产部署需要 CF_KV_NAMESPACE_ID');
                process.exit(1);
            }
        }
    }
    
    return allVars;
}

// 生成 wrangler.toml
function generateWranglerToml() {
    const buildTomlPath = path.join(projectRoot, 'wrangler.build.toml');
    const tomlPath = path.join(projectRoot, 'wrangler.toml');
    
    if (!fs.existsSync(buildTomlPath)) {
        console.error('错误: 未找到 wrangler.build.toml');
        process.exit(1);
    }
    
    let tomlContent = fs.readFileSync(buildTomlPath, 'utf8');
    
    // 替换占位符
    const varsToReplace = ['WORKER_NAME', 'CLOUDFLARE_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'KV_PREVIEW_ID'];
    
    for (const varName of varsToReplace) {
        const value = process.env[varName] || '';
        const regex = new RegExp(`\\$\\{${varName}\\}`, 'g');
        tomlContent = tomlContent.replace(regex, value);
    }
    
    // 处理 preview_id
    if (!process.env.KV_PREVIEW_ID) {
        if (process.env.NODE_ENV !== 'production' && process.env.CF_KV_NAMESPACE_ID) {
            // 本地开发模式且设置了生产 ID：提供占位符以绕过 Wrangler 的强制校验
            let dummyId = '00000000000000000000000000000000';
            if (dummyId === process.env.CF_KV_NAMESPACE_ID) {
                dummyId = 'ffffffffffffffffffffffffffffffff';
            }
            tomlContent = tomlContent.replace(/preview_id = .*/, `preview_id = "${dummyId}"`);
            console.log('本地开发模式：已设置占位符 preview_id 以绕过 Wrangler 验证。');
        } else {
            // 生产环境或完全没有 KV 配置：移除 preview_id 行
            tomlContent = tomlContent.replace(/preview_id = .*/g, '');
            console.log('已从 wrangler.toml 中移除 preview_id。');
            
            if (!process.env.CF_KV_NAMESPACE_ID) {
                // 如果两者都为空，移除整个 kv_namespaces 绑定
                tomlContent = tomlContent.replace(/\[\[kv_namespaces\]\][\s\S]*?(?=\[|$)/g, '');
            }
        }
    }
    
    if (process.env.WRANGLER_MODE === 'local') {
        console.log('本地开发模式：移除 KV ID 以强制使用本地模拟');
        tomlContent = tomlContent.replace(/^id = .*/gm, '');
        tomlContent = tomlContent.replace(/^preview_id = .*/gm, '');
    } else if (process.env.WRANGLER_MODE === 'remote') {
        console.log('远程开发模式：检查 KV 配置');
        if (!process.env.CF_KV_NAMESPACE_ID || !process.env.KV_PREVIEW_ID) {
            console.error('错误: 远程开发模式需要 CF_KV_NAMESPACE_ID 和 KV_PREVIEW_ID');
            console.error('请在 .env 文件中设置这些变量');
            process.exit(1);
        }
    }
    
    // 校验构建结果：检查是否还有未替换的占位符
    if (/\$\{[^}]+\}/.test(tomlContent)) {
        console.error('错误: wrangler.toml 中仍存在未替换的占位符变量');
        const matches = tomlContent.match(/\$\{[^}]+\}/g);
        console.error('未替换的变量:', matches);
        process.exit(1);
    }
    
    fs.writeFileSync(tomlPath, tomlContent);
    
    // 如果是非 GHA 环境（本地），追加 [vars] 块到 wrangler.toml
    if (process.env.GITHUB_ACTIONS !== 'true') {
        const manifestPath = path.join(projectRoot, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const envConfig = manifest.config?.env || {};
        
        // 提取类型为 string, number, boolean 的配置项
        const entries = Object.entries(envConfig)
            .filter(([_, config]) => ['string', 'number', 'boolean'].includes(config.type));
        
        if (entries.length > 0) {
            tomlContent += '\n[vars]\n';
            
            for (const [key, config] of entries) {
                const val = process.env[key];
                const finalVal = val || config.default || '';
                
                if (finalVal !== '') {
                    if (config.type === 'string') {
                        const escapedVal = finalVal.replace(/"/g, '\\"');
                        tomlContent += `${key} = "${escapedVal}"\n`;
                    } else {
                        tomlContent += `${key} = ${finalVal}\n`;
                    }
                }
            }
            
            fs.writeFileSync(tomlPath, tomlContent);
        }
        
        console.log('正在本地环境中向 wrangler.toml 追加业务变量...');
    }
    
    console.log('wrangler.toml updated successfully. VERSION will be injected dynamically via esbuild --define during build.');
}

// 主函数
function main() {
    try {
        loadEnvFile();

        ['GHA_SECRETS_JSON', 'GHA_VARS_JSON'].forEach(key => {
            if (process.env[key]) {
                try {
                    const data = JSON.parse(process.env[key]);
                    Object.entries(data).forEach(([k, v]) => {
                        // 只要有真实值 v，就强制覆盖当前的占位符
                        if (v !== undefined && v !== null && v !== '') {
                            process.env[k] = String(v);
                        }
                    });
                } catch (e) { console.warn(`解析 ${key} 失败:`, e.message); }
            }
        });

        checkRequiredVariables();

        extractVariablesFromManifest();
        generateWranglerToml();
    } catch (error) {
        console.error('构建失败:', error.message);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (process.argv[1] === __filename) {
    main();
}

/**
 * 生成 wrangler.toml 内容（用于测试）
 * 这是一个简化的版本，用于支持单元测试
 */
function generateToml(env, manifest, tomlTemplate, packageJson) {
    let content = tomlTemplate;
    
    // 替换占位符
    const varsToReplace = ['WORKER_NAME', 'CLOUDFLARE_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'KV_PREVIEW_ID'];
    
    for (const varName of varsToReplace) {
        const value = env[varName] || '';
        const regex = new RegExp(`\\$\\{${varName}\\}`, 'g');
        content = content.replace(regex, value);
    }
    
    // 处理 preview_id
    if (!env.KV_PREVIEW_ID) {
        if (env.NODE_ENV !== 'production' && env.CF_KV_NAMESPACE_ID) {
            // 本地开发模式且设置了生产 ID：提供占位符以绕过 Wrangler 的强制校验
            let dummyId = '00000000000000000000000000000000';
            if (dummyId === env.CF_KV_NAMESPACE_ID) {
                dummyId = 'ffffffffffffffffffffffffffffffff';
            }
            content = content.replace(/preview_id = .*/, `preview_id = "${dummyId}"`);
        } else {
            // 生产环境或完全没有 KV 配置：移除 preview_id 行
            content = content.replace(/preview_id = .*/g, '');
            
            if (!env.CF_KV_NAMESPACE_ID) {
                // 如果两者都为空，移除整个 kv_namespaces 绑定
                content = content.replace(/\[\[kv_namespaces\]\][\s\S]*?(?=\[|$)/g, '');
            }
        }
    }
    
    // 如果是非 GHA 环境（本地），追加 [vars] 块
    if (env.GITHUB_ACTIONS !== 'true') {
        const envConfig = manifest.config?.env || {};
        const entries = Object.entries(envConfig)
            .filter(([_, config]) => ['string', 'number', 'boolean'].includes(config.type));
        
        if (entries.length > 0) {
            content += '\n[vars]\n';
            
            for (const [key, config] of entries) {
                const val = env[key];
                const finalVal = val || config.default || '';
                
                if (finalVal !== '') {
                    if (config.type === 'string') {
                        const escapedVal = finalVal.replace(/"/g, '\\"');
                        content += `${key} = "${escapedVal}"\n`;
                    } else {
                        content += `${key} = ${finalVal}\n`;
                    }
                }
            }
        }
    }
    
    return content;
}

export { loadEnvFile, checkRequiredVariables, extractVariablesFromManifest, generateWranglerToml, generateToml };