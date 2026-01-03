import fs from 'fs';
import path from 'path';

/**
 * 脱敏敏感信息
 * @param {string} str - 需要脱敏的字符串
 * @returns {string} - 脱敏后的字符串
 */
function redactSensitiveInfo(str) {
    if (!str) return str;
    
    // 脱敏常见的敏感信息模式
    const patterns = [
        // API Keys (通常较长，包含字母数字)
        { regex: /--var\s+([^=]+)="([^"]*)"/g, replacement: (match, key, value) => `--var ${key}="***REDACTED***"` },
        // 环境变量值 (引号内的内容)
        { regex: /export\s+(\w+)="([^"]{10,})"/g, replacement: (match, key, value) => `export ${key}="***REDACTED***"` },
        // Account IDs (32位十六进制)
        { regex: /\b[a-f0-9]{32}\b/g, replacement: '***ACCOUNT_ID***' },
        // Tokens (通常包含特殊字符)
        { regex: /"[a-zA-Z0-9_\-\.]{20,}"/g, replacement: '"***REDACTED***"' },
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
        console.error(`错误: 缺少必需的环境变量 ${key}`);
        // In test mode, we might want to throw instead of exit
        if (env.NODE_ENV === 'test') {
          throw new Error(`缺少必需的环境变量 ${key}`);
        }
        process.exit(1);
      }

      // 只有当值存在且不为空时才添加
      if (value !== undefined && value !== '') {
        const escapedValue = String(value).replace(/"/g, '\\"');
        vars.push(`--var`, `${key}=${escapedValue}`);
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
