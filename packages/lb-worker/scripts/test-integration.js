import { renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const envPath = './.env';
const bakPath = './.env.bak';

// 1. 备份 .env
let hasBackup = false;
if (existsSync(envPath)) {
  console.log('📦 备份生产 .env 文件...');
  renameSync(envPath, bakPath);
  hasBackup = true;
}

try {
  // 2. 运行集成测试，并转发所有参数
  console.log('🚀 启动集成测试...');
  
  // 获取传递给脚本的参数
  const args = process.argv.slice(2);
  
  // 如果没有提供核心参数，添加默认的命令
  const vitestArgs = args.length > 0 ? args : ['run', '-c', 'vitest.integration.config.ts'];
  
  // 确保配置文件被包含（如果没有显式指定的话）
  if (!args.includes('-c') && !args.includes('--config')) {
    vitestArgs.push('-c', 'vitest.integration.config.ts');
  }

  const result = spawnSync('npx', ['vitest', ...vitestArgs], {
    stdio: 'inherit',
    shell: true
  });
  
  process.exitCode = result.status;
} finally {
  // 3. 恢复 .env
  if (hasBackup) {
    console.log('⏪ 恢复生产 .env 文件...');
    renameSync(bakPath, envPath);
  }
}
