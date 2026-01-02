import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

describe('generate-wrangler-vars.js (GHA & Manifest Driven)', () => {
  const scriptPath = 'scripts/generate-wrangler-vars.js';

  test('should generate --var from GHA JSON contexts and manifest', () => {
    const mockEnv = {
      ...process.env,
      GHA_SECRETS_JSON: JSON.stringify({
        NF_REDIS_PASSWORD: 'secret-password',
        AXIOM_TOKEN: 'axiom-secret',
        QSTASH_CURRENT_SIGNING_KEY: 'qstash-key'
      }),
      GHA_VARS_JSON: JSON.stringify({
        NF_REDIS_URL: 'https://vars.url',
        NODE_ENV: 'production'
      })
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    
    // 基础命令结构
    expect(output).toContain('npx wrangler deploy');
    expect(output).toContain('-c wrangler.toml');
    expect(output).toContain('--compatibility-flags="nodejs_compat"');

    // 验证变量注入 (Secrets 优先级高)
    expect(output).toContain('--var NF_REDIS_PASSWORD:"secret-password"');
    expect(output).toContain('--var AXIOM_TOKEN:"axiom-secret"');
    expect(output).toContain('--var QSTASH_CURRENT_SIGNING_KEY:"qstash-key"');
    expect(output).toContain('--var NF_REDIS_URL:"https://vars.url"');
    expect(output).toContain('--var NODE_ENV:"production"');

    // WORKER_NAME 不在 manifest.config.env 中，不应作为 --var 导入
    expect(output).not.toContain('--var WORKER_NAME');
  });

  test('should prioritize secrets over vars', () => {
    const mockEnv = {
      ...process.env,
      GHA_SECRETS_JSON: JSON.stringify({
        AXIOM_TOKEN: 'secret-value',
        QSTASH_CURRENT_SIGNING_KEY: 'qstash-key' // 必需变量
      }),
      GHA_VARS_JSON: JSON.stringify({ AXIOM_TOKEN: 'vars-value' })
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    expect(output).toContain('--var AXIOM_TOKEN:"secret-value"');
  });

  test('should handle special characters in values', () => {
    const mockEnv = {
      ...process.env,
      GHA_SECRETS_JSON: JSON.stringify({
        AXIOM_TOKEN: 'token"with"quotes',
        QSTASH_CURRENT_SIGNING_KEY: 'qstash-key' // 必需变量
      })
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    // 验证转义逻辑
    expect(output).toContain('--var AXIOM_TOKEN:"token\\"with\\"quotes"');
  });

  test('should exit with error if required variable is missing', () => {
    // 验证当必需变量缺失时，脚本会报错退出
    const mockEnv = {
      ...process.env,
      GHA_SECRETS_JSON: JSON.stringify({ AXIOM_TOKEN: 'test' }), // 缺少 QSTASH_CURRENT_SIGNING_KEY
      GHA_VARS_JSON: JSON.stringify({})
    };

    // 期望脚本以非零状态码退出
    expect(() => {
      execSync(`node ${scriptPath}`, { env: mockEnv, stdio: 'pipe' });
    }).toThrow();
  });
});

describe('build.sh (Local vs GHA)', () => {
  const wranglerPath = 'wrangler.toml';
  const backupPath = 'wrangler.toml.bak';
  const envPath = '.env';
  const envBackupPath = '.env.bak.test';

  beforeAll(() => {
    if (fs.existsSync(wranglerPath)) {
      fs.copyFileSync(wranglerPath, backupPath);
    }
    // 临时移除 .env 以免干扰测试环境变量
    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, envBackupPath);
      fs.unlinkSync(envPath);
    }
  });

  afterAll(() => {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, wranglerPath);
      fs.unlinkSync(backupPath);
    }
    if (fs.existsSync(envBackupPath)) {
      fs.copyFileSync(envBackupPath, envPath);
      fs.unlinkSync(envBackupPath);
    }
  });

  test('should append [vars] in local environment', () => {
    // 模拟本地环境
    // 直接在 bash 命令中传递所有变量，确保不受 Windows 环境影响
    const cmd = 'bash -c "GITHUB_ACTIONS=false NODE_ENV=development WORKER_NAME=test-local-worker QSTASH_CURRENT_SIGNING_KEY=local-key CLOUDFLARE_ACCOUNT_ID=test-id CF_KV_NAMESPACE_ID=test-kv bash scripts/build.sh"';
    
    execSync(cmd);
    
    const content = fs.readFileSync(wranglerPath, 'utf8');
    expect(content).toContain('[vars]');
    expect(content).toContain('QSTASH_CURRENT_SIGNING_KEY = "local-key"');
    expect(content).toContain('name = "test-local-worker"');
  });

  test('should NOT append [vars] in GHA environment', () => {
    const cmd = 'bash -c "GITHUB_ACTIONS=true NODE_ENV=production WORKER_NAME=gha-worker CLOUDFLARE_ACCOUNT_ID=test-id CF_KV_NAMESPACE_ID=test-kv bash scripts/build.sh"';
    
    execSync(cmd);
    
    const content = fs.readFileSync(wranglerPath, 'utf8');
    expect(content).not.toContain('[vars]');
    expect(content).toContain('name = "gha-worker"');
  });
});