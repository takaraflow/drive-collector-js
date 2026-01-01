import fs from 'fs';
import path from 'path';

/**
 * 动态生成 wrangler deploy 命令，自动注入 manifest.json 中定义且在 process.env 中存在的变量
 */
function generateWranglerCommand() {
  try {
    const manifestPath = path.resolve(process.cwd(), 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.error('manifest.json not found');
      return 'npx wrangler deploy';
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const envConfig = manifest.config?.env || {};
    const vars = [];

    for (const [key, config] of Object.entries(envConfig)) {
      // 过滤掉 KV namespace 等 binding 类型，只处理普通变量/密钥
      // 同时只处理 process.env 中确实存在的变量（动态导入已填项）
      if (config.type !== 'kv-namespace' && process.env[key] !== undefined && process.env[key] !== '') {
        // 使用双引号包裹值，处理特殊字符
        vars.push(`--var ${key}:"${process.env[key].replace(/"/g, '\\"')}"`);
      }
    }

    return `npx wrangler deploy ${vars.join(' ')}`;
  } catch (error) {
    console.error('Error generating wrangler command:', error.message);
    return 'npx wrangler deploy';
  }
}

console.log(generateWranglerCommand());
