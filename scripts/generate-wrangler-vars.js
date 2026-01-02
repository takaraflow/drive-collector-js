import fs from 'fs';
import path from 'path';

/**
 * 终极动态生成 wrangler deploy 命令
 * 1. 从 GHA Context JSON (GHA_SECRETS_JSON, GHA_VARS_JSON) 解析所有变量
 * 2. 结合当前 process.env
 * 3. 根据 manifest.json 定义自动匹配并注入
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

    const vars = [];
    for (const [key, config] of Object.entries(envConfig)) {
      const value = allAvailableVars[key];
      if (config.type !== 'kv-namespace' && value !== undefined && value !== '') {
        // 使用双引号包裹值，处理特殊字符
        vars.push(`--var ${key}:"${String(value).replace(/"/g, '\\"')}"`);
      }
    }

    return `npx wrangler deploy --compatibility-flags="nodejs_compat" ${vars.join(' ')}`;
  } catch (error) {
    console.error('Error generating wrangler command:', error.message);
    return 'npx wrangler deploy';
  }
}

console.log(generateWranglerCommand());
