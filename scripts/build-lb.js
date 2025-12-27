import fs from 'fs';

// 读取 wrangler.toml 模板
const template = fs.readFileSync('wrangler.toml', 'utf8');

// 定义必需的环境变量列表
const requiredVars = ['WORKER_NAME', 'CF_KV_NAMESPACE_ID', 'QSTASH_CURRENT_SIGNING_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

// 验证必需的环境变量
for (const varName of requiredVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

// 使用正则表达式替换所有 ${VAR} 格式的占位符
let output = template.replace(/\$\{([^}]+)\}/g, (match, varName) => {
  let value = process.env[varName];
  if (value === undefined) {
    if (varName === 'KV_PREVIEW_ID') {
      value = process.env.CF_KV_NAMESPACE_ID;
    } else {
      throw new Error(`Environment variable ${varName} is not set`);
    }
  }
  return value;
});

// 生成 wrangler.build.toml
fs.writeFileSync('wrangler.build.toml', output);

console.log('wrangler.build.toml generated successfully');