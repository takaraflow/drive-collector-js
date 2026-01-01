import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import { execSync } from 'child_process';

describe('generate-wrangler-vars.js', () => {
  const scriptPath = 'scripts/generate-wrangler-vars.js';

  test('should generate correct wrangler command with env vars', () => {
    // 设置模拟环境变量
    const mockEnv = {
      ...process.env,
      NF_REDIS_URL: 'https://test.url',
      NF_REDIS_PASSWORD: 'test-password',
      AXIOM_TOKEN: 'axiom-123',
      KV_STORAGE: 'binding-should-be-ignored'
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    
    expect(output).toContain('npx wrangler deploy');
    expect(output).toContain('--var NF_REDIS_URL:"https://test.url"');
    expect(output).toContain('--var NF_REDIS_PASSWORD:"test-password"');
    expect(output).toContain('--var AXIOM_TOKEN:"axiom-123"');
    // KV_STORAGE 是 kv-namespace 类型，不应作为 --var 导入
    expect(output).not.toContain('--var KV_STORAGE');
  });

  test('should skip empty or undefined env vars', () => {
    const mockEnv = {
      ...process.env,
      NF_REDIS_URL: 'https://test.url',
      NF_REDIS_PASSWORD: '', // 空字符串
      AXIOM_TOKEN: undefined // undefined
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    
    expect(output).toContain('--var NF_REDIS_URL:"https://test.url"');
    expect(output).not.toContain('--var NF_REDIS_PASSWORD');
    expect(output).not.toContain('--var AXIOM_TOKEN');
  });
});
