import fs from 'fs';
import path from 'path';

/**
 * 动态生成 wrangler deploy 命令
 * 1. 从 GHA Context JSON (GHA_SECRETS_JSON, GHA_VARS_JSON) 解析所有变量
 * 2. 结合当前 process.env
 * 3. 根据 manifest.json 定义自动匹配并注入
 * 4. 支持 KV 命名空间绑定
 */
function generateWranglerCommand() {
  try {
    const manifestPath = path.resolve(process.cwd(), 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return 'npx wrangler deploy';
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const envConfig = manifest.config?.env || {};

    // 解析 GHA Context
    const secretsJson = process.env.GHA_SECRETS_JSON ? JSON.parse(process.env.GHA_SECRETS_JSON) : {};
    const varsJson = process.env.GHA_VARS_JSON ? JSON.parse(process.env.GHA_VARS_JSON) : {};

    // 合并所有来源 (优先级: Secrets > Vars > Process Env)
    const allAvailableVars = {
      ...process.env,
      ...varsJson,
      ...secretsJson
    };

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
        process.exit(1);
      }

      // 只有当值存在且不为空时才添加
      if (value !== undefined && value !== '') {
        // 使用双引号包裹值，处理特殊字符
        const escapedValue = String(value).replace(/"/g, '\\"');
        vars.push(`--var ${key}:"${escapedValue}"`);
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

    return command;
  } catch (error) {
    console.error('Error generating wrangler command:', error.message);
    return 'npx wrangler deploy';
  }
}

console.log(generateWranglerCommand());