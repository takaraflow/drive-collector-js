import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// 加载 .env 文件 (如果存在)
dotenv.config();

/**
 * 脱敏敏感信息
 * @param {string} str - 需要脱敏的字符串
 * @returns {string} - 脱敏后的字符串
 */
function redactSensitiveInfo(str) {
    if (!str) return str;
    
    // 脱敏敏感信息模式：动态识别包含 TOKEN, KEY, SECRET, PASSWORD, PWD 的变量
    const patterns = [
        {
            regex: /(--var\s+)([^=]*(?:TOKEN|KEY|SECRET|PASSWORD|PWD)[^=]*)(="?)([^" ]+)("?)/gi,
            replacement: (match, p1, p2, p3, p4, p5) => `${p1}${p2}${p3}***REDACTED***${p5}`
        },
        {
            regex: /(export\s+)([^=]*(?:TOKEN|KEY|SECRET|PASSWORD|PWD)[^=]*)(="?)([^" ]+)("?)/gi,
            replacement: (match, p1, p2, p3, p4, p5) => `${p1}${p2}${p3}***REDACTED***${p5}`
        }
    ];
    
    let result = str;
    for (const { regex, replacement } of patterns) {
        result = result.replace(regex, replacement);
    }
    return result;
}

/**
 * 动态生成 wrangler deploy 命令
 * 1. 从 GHA Context JSON (GHA_SECRETS_JSON, GHA_VARS_JSON) 解析所有变量
 * 2. 结合当前 process.env
 * 3. 根据 manifest.json 定义自动匹配并注入
 * 4. 支持 KV 命名空间绑定
 */
export function generateWranglerCommand(env = process.env) {
  try {
    const manifestPath = path.resolve(process.cwd(), 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return 'npx wrangler deploy';
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const envConfig = manifest.config?.env || {};
    const infraConfig = manifest.infrastructure || {};

    // 解析 GHA Context
    const secretsJson = env.GHA_SECRETS_JSON ? JSON.parse(env.GHA_SECRETS_JSON) : {};
    const varsJson = env.GHA_VARS_JSON ? JSON.parse(env.GHA_VARS_JSON) : {};

    const allAvailableVars = {
      ...env,
      ...varsJson,
      ...secretsJson
    };

    const extraExports = [];
    for (const key of Object.keys(infraConfig)) {
        if (allAvailableVars[key] !== undefined && env[key] === undefined) {
             extraExports.push(`export ${key}="${allAvailableVars[key]}"`);
        }
    }
    
    const args = [];
    const vars = [];

    // 处理环境变量
    for (const [key, config] of Object.entries(envConfig)) {
      // 跳过 KV 命名空间，它们通过 --kv 绑定
      if (config.type === 'kv-namespace') continue;

      const value = allAvailableVars[key];
      
      // 检查是否为必需变量
      if (config.required && (value === undefined || value === '')) {
        // 在本地调试模式下 (非 GHA 环境)，只打印警告而不退出
        if (!env.GITHUB_ACTIONS && !env.ACT) {
            console.warn(`⚠️ 警告: 缺少必需的环境变量 [${key}]，已跳过`);
            continue;
        }
        
        console.error(`❌ 错误: 缺少必需的环境变量 [${key}]`);
        // In test mode, we might want to throw instead of exit
        if (env.NODE_ENV === 'test') {
          throw new Error(`缺少必需的环境变量 ${key}`);
        }
        process.exit(1);
      }

      // 只有当值存在且不为空时才添加
      if (value !== undefined && value !== '') {
        // 清理值两侧可能存在的冗余引号（Infisical 导出有时会带引号）
        const cleanValue = String(value).trim().replace(/^['"]|['"]$/g, '');
        const escapedValue = cleanValue.replace(/"/g, '\\"');
        
        // 关键：只将 config.env 中的变量注入为 --var
        // infrastructure 中的变量 (如 CLOUDFLARE_ACCOUNT_ID) 不需要也不应该作为 Worker 的业务变量注入
        if (envConfig[key]) {
            vars.push(`--var`, `${key}="${escapedValue}"`);
        }
      }
    }

    // 处理 KV 命名空间绑定 (从 manifest 中提取)
    // 注意：这里假设 KV 绑定名称是固定的，或者需要从 wrangler.build.toml 读取
    // 为了简化，我们只处理业务变量，KV 绑定通常在 wrangler.toml 中定义
    // 但如果需要动态 KV，可以在这里添加逻辑

    // 构建基础命令
    let command = 'npx wrangler deploy -c wrangler.toml --compatibility-flags="nodejs_compat"';
    
    // 添加所有 --var 参数
    if (vars.length > 0) {
      command += ' ' + vars.join(' ');
    }

    // 如果有额外的 exports，将它们前置到命令中
    // 注意：eval 会执行整个字符串。
    // 格式：export A="b"; export C="d"; npx wrangler ...
    if (extraExports.length > 0) {
        command = extraExports.join('; ') + '; ' + command;
    }

    return command;
  } catch (error) {
    console.error('Error generating wrangler command:', error.message);
    if (env.NODE_ENV === 'test') throw error;
    return 'npx wrangler deploy';
  }
}

// Only execute if running directly
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 脱敏后输出命令
  console.log(redactSensitiveInfo(generateWranglerCommand()));
}
