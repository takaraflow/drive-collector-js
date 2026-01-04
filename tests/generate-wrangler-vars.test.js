import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import path from 'path';

// Mock Modules
// Use unstable_mockModule for fs to support named exports used by implementation
jest.unstable_mockModule('fs', () => ({
    default: {
        existsSync: jest.fn(),
        readFileSync: jest.fn(),
        copyFileSync: jest.fn(),
        unlinkSync: jest.fn(),
        writeFileSync: jest.fn(),
    },
    // Named exports needed because implementation might use named imports
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    copyFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    writeFileSync: jest.fn(),
}));

jest.unstable_mockModule('child_process', () => ({
  execSync: jest.fn()
}));

// We need to import the mocked modules dynamically after defining mocks
const fs = await import('fs');
// const { execSync } = await import('child_process');

// Import code under test DYNAMICALLY after mocking
const { generateWranglerCommand } = await import('../scripts/generate-wrangler-vars.js');
const { generateToml } = await import('../scripts/build-logic.js');

describe('generate-wrangler-vars.js (Unit)', () => {
  const mockManifest = {
    config: {
      env: {
        NF_REDIS_PASSWORD: { type: "string" },
        AXIOM_TOKEN: { type: "string" },
        QSTASH_CURRENT_SIGNING_KEY: { type: "string", required: true },
        NF_REDIS_URL: { type: "string" },
        NODE_ENV: { type: "string" },
        WORKER_NAME: { type: "string" }
      }
    },
    infrastructure: {
      CLOUDFLARE_ACCOUNT_ID: { type: "string", required: true },
      WORKER_NAME: { type: "string", required: true },
      CF_KV_NAMESPACE_ID: { type: "string", required: true },
      KV_PREVIEW_ID: { type: "string", required: false }
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set both default and named export mocks to ensure coverage
    fs.default.existsSync.mockReturnValue(true);
    fs.default.readFileSync.mockReturnValue(JSON.stringify(mockManifest));
    
    // Also mock named exports if they are separate in the mock definition
    if (fs.existsSync && fs.existsSync.mockReturnValue) {
        fs.existsSync.mockReturnValue(true);
    }
    if (fs.readFileSync && fs.readFileSync.mockReturnValue) {
        fs.readFileSync.mockReturnValue(JSON.stringify(mockManifest));
    }
  });

  test('should generate --var from GHA JSON contexts and manifest', () => {
    const mockEnv = {
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

    const output = generateWranglerCommand(mockEnv);
    
    // Debug output if it fails
    if (!output.includes('-c wrangler.toml')) {
        console.log('DEBUG: Output was:', output);
    }

    expect(output).toContain('npx wrangler deploy');
    expect(output).toContain('-c wrangler.toml');
    expect(output).toContain('--compatibility-flags="nodejs_compat"');

    expect(output).toContain('--var NF_REDIS_PASSWORD="secret-password"');
    expect(output).toContain('--var AXIOM_TOKEN="axiom-secret"');
    expect(output).toContain('--var QSTASH_CURRENT_SIGNING_KEY="qstash-key"');
    expect(output).toContain('--var NF_REDIS_URL="https://vars.url"');
    expect(output).toContain('--var NODE_ENV="production"');
  });

  test('should prioritize secrets over vars', () => {
    const mockEnv = {
      GHA_SECRETS_JSON: JSON.stringify({
        AXIOM_TOKEN: 'secret-value',
        QSTASH_CURRENT_SIGNING_KEY: 'qstash-key'
      }),
      GHA_VARS_JSON: JSON.stringify({ AXIOM_TOKEN: 'vars-value' })
    };

    const output = generateWranglerCommand(mockEnv);
    expect(output).toContain('--var AXIOM_TOKEN="secret-value"');
  });

  test('should handle special characters in values', () => {
    const mockEnv = {
      GHA_SECRETS_JSON: JSON.stringify({
        AXIOM_TOKEN: 'token"with"quotes',
        QSTASH_CURRENT_SIGNING_KEY: 'qstash-key'
      })
    };

    const output = generateWranglerCommand(mockEnv);
    expect(output).toContain('--var AXIOM_TOKEN="token\\"with\\"quotes"');
  });


  test('should handle infrastructure vars found in GHA JSON contexts', () => {
    const mockEnv = {
      GHA_VARS_JSON: JSON.stringify({
        CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
        WORKER_NAME: 'test-worker',
        QSTASH_CURRENT_SIGNING_KEY: 'test-key' // Added required var
      }),
      NODE_ENV: 'test'
    };

    const output = generateWranglerCommand(mockEnv);
    
    // 期望基础设施变量 (如 CLOUDFLARE_ACCOUNT_ID) 通过 export 导出
    // 而不是通过 --var 注入
    expect(output).toContain('export CLOUDFLARE_ACCOUNT_ID="test-account-id"');
    expect(output).toContain('--var WORKER_NAME="test-worker"');
    expect(output).not.toContain('--var CLOUDFLARE_ACCOUNT_ID');
  });


  test('should throw error if required variable is missing', () => {
    const mockEnv = {
      NODE_ENV: 'test',
      GITHUB_ACTIONS: 'true', // 强制进入 GHA 模式，触发严格检查
      GHA_SECRETS_JSON: JSON.stringify({ AXIOM_TOKEN: 'test' }),
      GHA_VARS_JSON: JSON.stringify({})
    };

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      generateWranglerCommand(mockEnv);
    }).toThrow('缺少必需的环境变量 QSTASH_CURRENT_SIGNING_KEY');

    consoleSpy.mockRestore();
  });
});

describe('build.sh Logic (Unit)', () => {
  const mockManifest = {
    config: {
      env: {
        QSTASH_CURRENT_SIGNING_KEY: { type: "string" },
        NAME: { type: "string" }
      }
    }
  };
  
  const mockPackageJson = { name: 'pkg-worker-name' };
  const mockTomlTemplate = `
name = "\${WORKER_NAME}"
account_id = "\${CLOUDFLARE_ACCOUNT_ID}"
kv_namespaces = [
  { binding = "KV", id = "\${CF_KV_NAMESPACE_ID}", preview_id = "\${KV_PREVIEW_ID}" }
]
`;

  test('should append [vars] in local environment', () => {
    const mockEnv = {
      GITHUB_ACTIONS: 'false',
      NODE_ENV: 'development',
      WORKER_NAME: 'test-local-worker',
      QSTASH_CURRENT_SIGNING_KEY: 'local-key',
      CLOUDFLARE_ACCOUNT_ID: 'test-id',
      CF_KV_NAMESPACE_ID: 'test-kv'
    };

    const content = generateToml(mockEnv, mockManifest, mockTomlTemplate, mockPackageJson);
    
    expect(content).toContain('[vars]');
    expect(content).toContain('QSTASH_CURRENT_SIGNING_KEY = "local-key"');
    expect(content).toContain('name = "test-local-worker"');
  });

  test('should NOT append [vars] in GHA environment', () => {
    const mockEnv = {
      GITHUB_ACTIONS: 'true',
      NODE_ENV: 'production',
      WORKER_NAME: 'gha-worker',
      CLOUDFLARE_ACCOUNT_ID: 'test-id',
      CF_KV_NAMESPACE_ID: 'test-kv'
    };

    const content = generateToml(mockEnv, mockManifest, mockTomlTemplate, mockPackageJson);
    
    expect(content).not.toContain('[vars]');
    expect(content).toContain('name = "gha-worker"');
  });

  test('should replace placeholders correctly', () => {
      const mockEnv = {
          WORKER_NAME: 'final-name',
          CLOUDFLARE_ACCOUNT_ID: 'acc-123',
          CF_KV_NAMESPACE_ID: 'kv-123',
          KV_PREVIEW_ID: 'prev-123'
      };
      
      const content = generateToml(mockEnv, mockManifest, mockTomlTemplate, mockPackageJson);
      
      expect(content).toContain('name = "final-name"');
      expect(content).toContain('account_id = "acc-123"');
      expect(content).toContain('id = "kv-123"');
      expect(content).toContain('preview_id = "prev-123"');
  });

  test('should use dummy preview_id in local dev with prod KV ID', () => {
      const mockEnv = {
          NODE_ENV: 'development',
          CF_KV_NAMESPACE_ID: 'prod-kv-id',
          KV_PREVIEW_ID: ''
      };
      
      const content = generateToml(mockEnv, mockManifest, mockTomlTemplate, mockPackageJson);
      expect(content).toContain('preview_id = "00000000000000000000000000000000"');
  });
});

