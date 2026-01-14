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
  // 2. 运行真正的集成测试
  console.log('🚀 启动集成测试...');
  const result = spawnSync('npx', ['vitest', 'run', '-c', 'vitest.integration.config.ts'], {
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
