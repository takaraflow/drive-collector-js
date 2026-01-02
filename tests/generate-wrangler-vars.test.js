import { jest, describe, test, expect } from '@jest/globals';
import { execSync } from 'child_process';

describe('generate-wrangler-vars.js (Ultimate Dynamic)', () => {
  const scriptPath = 'scripts/generate-wrangler-vars.js';

  test('should parse GHA JSON contexts and match manifest', () => {
    const mockEnv = {
      ...process.env,
      GHA_SECRETS_JSON: JSON.stringify({
        NF_REDIS_PASSWORD: 'secret-password',
        AXIOM_TOKEN: 'axiom-secret'
      }),
      GHA_VARS_JSON: JSON.stringify({
        NF_REDIS_URL: 'https://vars.url',
        WORKER_NAME: 'lb-worker'
      })
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    
    expect(output).toContain('npx wrangler deploy');
    expect(output).toContain('-c wrangler.build.toml');
    expect(output).toContain('--var NF_REDIS_PASSWORD:"secret-password"');
    expect(output).toContain('--var AXIOM_TOKEN:"axiom-secret"');
    expect(output).toContain('--var NF_REDIS_URL:"https://vars.url"');
    // WORKER_NAME 不在 manifest.config.env 中，不应作为 --var 导入 (它是部署参数)
    expect(output).not.toContain('--var WORKER_NAME');
  });

  test('should prioritize secrets over vars', () => {
    const mockEnv = {
      ...process.env,
      GHA_SECRETS_JSON: JSON.stringify({ NF_REDIS_URL: 'https://secret.url' }),
      GHA_VARS_JSON: JSON.stringify({ NF_REDIS_URL: 'https://vars.url' })
    };

    const output = execSync(`node ${scriptPath}`, { env: mockEnv }).toString().trim();
    expect(output).toContain('--var NF_REDIS_URL:"https://secret.url"');
  });
});