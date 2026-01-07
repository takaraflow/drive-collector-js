#!/usr/bin/env node

/**
 * 跨平台的构建逻辑脚本
 * 替代 build.sh 中的 shell 脚本逻辑，确保在 GHA Linux 和 Windows 环境下都能正常工作
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function determineVersion(root) {
    const manifestPath = path.join(root, 'manifest.json');
    let version = '';

    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest && typeof manifest.version === 'string') {
                version = manifest.version.trim();
            }
        } catch (error) {
            console.warn('解析 manifest.json 版本号失败:', error.message);
        }
    }

    if (!version) {
        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                version = (pkg.version || '').trim();
            } catch (error) {
                console.warn('解析 package.json 版本号失败:', error.message);
            }
        }
    }

    return version || 'dev';
}

// 从 .env 文件加载环境变量
function loadEnvFile(fileSystem = fs, targetEnv = 'dev') {
    // 1. 优先加载 .env.${targetEnv}
    const specificEnvPath = path.join(projectRoot, `.env.${targetEnv}`);
    if (fileSystem.existsSync(specificEnvPath)) {
        const envContent = fileSystem.readFileSync(specificEnvPath, 'utf8');
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
                
                for (let charIndex = 0; charIndex < value.length; charIndex++) {
                    const char = value[charIndex];

                    if ((char === '"' || char === "'") && (charIndex === 0 || value[charIndex-1] !== '\\')) {
                        if (!inQuotes) {
                            inQuotes = true;
                            quoteChar = char;
                        } else if (char === quoteChar) {
                            inQuotes = false;
                            quoteChar = null;
                        }
                    } else if (char === '#' && !inQuotes) {
                        commentStart = charIndex;
                        break;
                    }
                }
                
                // 移除注释部分
                if (commentStart !== -1) {
                    value = value.substring(0, commentStart).trim();
                } else {
                    value = value.trim();
                }
                
                // 循环去除所有包围的引号
                while (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
                    value = value.substring(1, value.length - 1);
                }
                
                const keyTrim = key.trim();
                const currentVal = process.env[keyTrim];
                // 只有当环境变量不存在，或者是 ${VAR} 这种占位符时，才从 .env 加载
                if (!currentVal || currentVal === `\${${keyTrim}}`) {
                    process.env[keyTrim] = value;
                }
            }
        }
    }

    // 2. 然后加载 .env (作为 fallback，不会覆盖已存在的值)
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
                
                for (let charIndex = 0; charIndex < value.length; charIndex++) {
                    const char = value[charIndex];

                    if ((char === '"' || char === "'") && (charIndex === 0 || value[charIndex-1] !== '\\')) {
                        if (!inQuotes) {
                            inQuotes = true;
                            quoteChar = char;
                        } else if (char === quoteChar) {
                            inQuotes = false;
                            quoteChar = null;
                        }
                    } else if (char === '#' && !inQuotes) {
                        commentStart = charIndex;
                        break;
                    }
                }
                
                // 移除注释部分
                if (commentStart !== -1) {
                    value = value.substring(0, commentStart).trim();
                } else {
                    value = value.trim();
                }
                
                // 循环去除所有包围的引号
                while (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
                    value = value.substring(1, value.length - 1);
                }
                
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
    
    // 从 manifest.json infrastructure 动态提取关键部署变量，不再硬编码
    const infraConfig = manifest.infrastructure || {};
    const infraVars = Object.keys(infraConfig);
    const allVars = [...vars, ...infraVars];
    
    // 清理可能误传为占位符字符串的变量，并设置默认值
    for (const varName of allVars) {
        // 仅当环境变量的值明确等于其占位符形式 (e.g., VAR="${VAR}") 时，才删除它
        // 这样可以避免意外删除由外部环境（如 Infisical 或 GHA secrets）注入的、值为空字符串的变量
        if (process.env[varName] === `\${${varName}}`) {
            delete process.env[varName];
        }
        
        // 尝试从 manifest.json 获取默认值
        const defaultValue = envConfig[varName]?.default || '';
        
        // 优先级：环境变量 > Manifest 默认值 > 空字符串
        // 只有当环境变量不存在时才设置默认值
        if (process.env[varName] === undefined && defaultValue) {
            process.env[varName] = defaultValue;
        }
    }
    
    // 特殊默认值设置
    // ... (后续代码)
    // 从 package.json 提取 name 作为 WORKER_NAME 的默认值
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    
    if (!process.env.WORKER_NAME) {
        process.env.WORKER_NAME = pkg.name;
    }
    
    // AXIOM_DATASET should be provided via environment or manifest default, not hardcoded
    
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
    
    if (!process.env.GITHUB_ACTIONS && !process.env.CLOUDFLARE_ACCOUNT_ID) {
        const secretsPath = path.join(projectRoot, '.act.secrets');
        if (fs.existsSync(secretsPath)) {
            const content = fs.readFileSync(secretsPath, 'utf8');
            const lines = content.split('\n').filter(l => l && !l.startsWith('#'));
            
            for (const line of lines) {
                const [key, ...rest] = line.split('=');
                if (key === 'CLOUDFLARE_ACCOUNT_ID') {
                    const value = rest.join('=').replace(/^"|"$/g, '');
                    process.env.CLOUDFLARE_ACCOUNT_ID = value;
                    console.log('从 .act.secrets 读取 CLOUDFLARE_ACCOUNT_ID');
                    break;
                }
            }
        }
    }
    
    // 检查是否在 GitHub Actions 环境中
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log('检测到 GitHub Actions 环境...');
        
        // 2026-01-04: 增加调试信息（在 Infisical 拉取之后）
        console.log('DEBUG: GHA 环境变量检查 (Infisical 拉取后):');
        console.log('  - GITHUB_ACTIONS:', process.env.GITHUB_ACTIONS);
        console.log('  - CLOUDFLARE_ACCOUNT_ID:', process.env.CLOUDFLARE_ACCOUNT_ID ? '已设置' : '未设置');
        console.log('  - INFISICAL_TOKEN:', process.env.INFISICAL_TOKEN ? '已设置' : '未设置');
        console.log('  - INFISICAL_PROJECT_ID:', process.env.INFISICAL_PROJECT_ID ? '已设置' : '未设置');
        
        if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
            console.error('错误: GHA 环境下需要 CLOUDFLARE_ACCOUNT_ID');
            console.error('CLOUDFLARE_ACCOUNT_ID 应该通过 Infisical 从 GHA secrets 中获取');
            console.error('请检查 GitHub Actions 的 INFISICAL_TOKEN 和 INFISICAL_PROJECT_ID 配置');
            process.exit(1);
        }
        
        if (!process.env.CF_KV_NAMESPACE_ID) {
            console.log('警告: GHA 环境下 CF_KV_NAMESPACE_ID 为空，KV 绑定可能失效');
            if (process.env.NODE_ENV === 'production') {
                console.error('错误: 生产部署需要 CF_KV_NAMESPACE_ID');
                process.exit(1);
            }
        }
    } else {
        console.log('检测到本地开发环境...');
        // 本地开发环境：CLOUDFLARE_ACCOUNT_ID 应该从 .act.secrets 获取
        // 这里不做额外处理，因为 generate-wrangler-vars.js 已经处理了
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

    const manifestPath = path.join(projectRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const envConfig = manifest.config?.env || {};

    let tomlContent = fs.readFileSync(buildTomlPath, 'utf8');

    const placeholderRegex = /\$\{([^}]+)\}/g;
    tomlContent = tomlContent.replace(placeholderRegex, (match, varName) => {
        let value = (process.env[varName] || '').trim();
        while (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.substring(1, value.length - 1);
        }
        return value || match;
    });

    if (!process.env.KV_PREVIEW_ID) {
        if (process.env.NODE_ENV !== 'production' && process.env.CF_KV_NAMESPACE_ID) {
            let dummyId = '00000000000000000000000000000000';
            if (dummyId === process.env.CF_KV_NAMESPACE_ID) {
                dummyId = 'ffffffffffffffffffffffffffffffff';
            }
            tomlContent = tomlContent.replace(/preview_id = .*/, `preview_id = "${dummyId}"`);
            console.log('本地开发模式：已设置占位符 preview_id 以绕过 Wrangler 验证。');
        } else {
            tomlContent = tomlContent.replace(/preview_id = .*/g, '');
            console.log('已从 wrangler.toml 中移除 preview_id。');

            if (!process.env.CF_KV_NAMESPACE_ID) {
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

    if (/\$\{[^}]+\}/.test(tomlContent)) {
        console.error('错误: wrangler.toml 中仍存在未替换的占位符变量');
        const matches = tomlContent.match(/\$\{[^}]+\}/g);
        const varNames = matches ? matches.map(m => m.replace(/^\$\{|\}$/g, '')) : [];
        console.error('未替换的变量:', varNames.join(', '));
        process.exit(1);
    }

    const varsResult = buildVarsSection(envConfig);
    tomlContent = `${tomlContent.trimEnd()}\n\n${varsResult.section}\n`;
    fs.writeFileSync(tomlPath, tomlContent);

    if (varsResult.manifestCount > 0) {
        console.log('正在本地环境中向 wrangler.toml 追加业务变量...');
    }

    console.log('wrangler.toml updated successfully. VERSION is provided via Wrangler vars.');
}

function escapeTomlString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildVarsSection(envConfig = {}, envSource = process.env) {
    const versionValue = (envSource.VERSION || 'dev').trim() || 'dev';
    const lines = ['[vars]', `VERSION = "${escapeTomlString(versionValue)}"`];
    let manifestCount = 0;

    if (envSource.GITHUB_ACTIONS !== 'true') {
        const entries = Object.entries(envConfig)
            .filter(([_, config]) => ['string', 'number', 'boolean'].includes(config.type));

        for (const [key, config] of entries) {
            const val = envSource[key];
            const finalVal = val || config.default || '';

            if (finalVal === '') continue;

            manifestCount++;
            if (config.type === 'string') {
                lines.push(`${key} = "${escapeTomlString(finalVal)}"`);
            } else {
                lines.push(`${key} = ${finalVal}`);
            }
        }
    }

    return {
        section: lines.join('\n'),
        manifestCount
    };
}

// 主函数
function main() {
    try {
        // 1. 解析 --env 参数
        const envArg = process.argv.find(arg => arg.startsWith('--env='));
        const targetEnv = envArg ? envArg.split('=')[1] : 'dev'; // 默认为 dev

        // 2. 加载环境文件
        loadEnvFile(fs, targetEnv);

        ['GHA_SECRETS_JSON', 'GHA_VARS_JSON'].forEach(key => {
            if (process.env[key]) {
                try {
                    const data = JSON.parse(process.env[key]);
                    Object.entries(data).forEach(([k, v]) => {
                        // 只要有真实值 v，就强制覆盖当前的占位符
                        if (v !== undefined && v !== null && v !== '') {
                            let value = String(v);
                            // 循环去除所有包围的引号
                            while (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
                                value = value.substring(1, value.length - 1);
                            }
                             // 仅当环境变量尚未被外部（如 Infisical）设置时，才从 GHA JSON 中加载
                             if (!process.env[k]) {
                                 process.env[k] = value;
                             }
                        }
                    });
                } catch (e) { console.warn(`解析 ${key} 失败:`, e.message); }
            }
        });

        const resolvedVersion = determineVersion(projectRoot);
        if (!process.env.VERSION || process.env.VERSION === `\${VERSION}`) {
            process.env.VERSION = resolvedVersion;
        }

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
    
    // 动态发现并替换占位符，不再硬编码字段列表
    // 逻辑：寻找模板中所有的 ${VAR_NAME}，并尝试从环境中替换
    const placeholderRegex = /\$\{([^}]+)\}/g;
    content = content.replace(placeholderRegex, (match, varName) => {
        let value = (env[varName] || '').trim();
        // 循环去除所有包围的引号，修复协议头被错误去除的问题
        while (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.substring(1, value.length - 1);
        }
        return value || match; // 如果没值，保持原样（后续校验会报错）
    });
    
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
    
    const envConfig = manifest.config?.env || {};
    const varsResult = buildVarsSection(envConfig, env);
    content = `${content.trimEnd()}\n\n${varsResult.section}\n`;
    return content;
}

export { loadEnvFile, checkRequiredVariables, extractVariablesFromManifest, generateWranglerToml, generateToml };
