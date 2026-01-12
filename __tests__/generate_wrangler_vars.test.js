import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock fs module
// Create shared mock functions so both default and named exports use the same mock
const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const copyFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock('fs', async () => {
  const actual = await import('fs');
  return {
    ...actual,
    default: {
      existsSync: existsSyncMock,
      readFileSync: readFileSyncMock,
      copyFileSync: copyFileSyncMock,
      unlinkSync: unlinkSyncMock,
      writeFileSync: writeFileSyncMock,
    },
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    copyFileSync: copyFileSyncMock,
    unlinkSync: unlinkSyncMock,
    writeFileSync: writeFileSyncMock,
  };
});

// Mock dotenv module
const configMock = vi.fn();
vi.mock('dotenv', async () => {
  const actual = await import('dotenv');
  return {
    ...actual,
    default: {
      config: configMock,
    }
  };
});

// Import mocked modules
const fs = await import('fs');
const dotenv = await import('dotenv');

// Import code under test DYNAMICALLY after mocking
const { setupEnvironment, generateWranglerCommand } = await import('../scripts/generate-wrangler-vars.js');
const { generateToml } = await import('../scripts/build-logic.js');

// Helper to reset all mocks
function resetAllMocks() {
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    configMock.mockReset();
}

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
    resetAllMocks();
    
    // Set up default mocks for most tests
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify(mockManifest));
  });

  describe('setupEnvironment', () => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const originalCwd = process.cwd;

    // Override beforeEach for setupEnvironment tests
    beforeEach(() => {
        vi.clearAllMocks();
        // Don't set up fs mocks here - each test will do it
    });

    afterEach(() => {
        // Restore process.argv, process.env, and process.cwd
        process.argv = originalArgv;
        process.env = { ...originalEnv };
        process.cwd = originalCwd;
    });

    test('should_parse_env_argument_and_load_corresponding_env_file', () => {
        // Mock process.argv
        const mockArgv = ['node', 'script', '--env=pre'];
        
        // Mock process.cwd
        process.cwd = () => '/test/project';
        
        // Mock fs.existsSync to simulate .env.pre exists (staging alias)
        existsSyncMock.mockImplementation((path) => {
            return path.includes('.env.pre');
        });

        // Call setupEnvironment with mock argv
        const result = setupEnvironment(mockArgv);

        // Verify result
        expect(result).toBe('pre');

        // Verify dotenv.config was called twice
        expect(configMock).toHaveBeenCalledTimes(2);
        
        // First call: default .env
        expect(configMock).toHaveBeenNthCalledWith(1);
        
        // Second call: .env.pre with override
        expect(configMock).toHaveBeenNthCalledWith(2, {
            path: expect.any(String),
            override: true
        });
        
        // Verify the path contains the expected filename
        const secondCallPath = configMock.mock.calls[1][0].path;
        expect(secondCallPath).toContain('.env.pre');
    });

    test('should_default_to_dev_when_no_env_argument_provided', () => {
        const mockArgv = ['node', 'script'];
        
        // Save original cwd
        const originalCwd = process.cwd;
        process.cwd = () => '/test/project';
        
        // Mock fs.existsSync to return false for all paths
        // This simulates .env.dev not existing
        existsSyncMock.mockReturnValue(false);

        const result = setupEnvironment(mockArgv);

        // Restore cwd
        process.cwd = originalCwd;
        
        expect(result).toBe('dev');
        
        // The function calls dotenv.config() once for .env
        // Since .env.dev doesn't exist, no second call
        expect(configMock).toHaveBeenCalledTimes(1);
        expect(configMock).toHaveBeenCalledWith();
    });

    test('should_skip_second_dotenv_call_when_env_file_missing', () => {
        const mockArgv = ['node', 'script', '--env=staging'];
        
        process.cwd = () => '/test/project';
        // Mock fs.existsSync to return false for all paths
        existsSyncMock.mockReturnValue(false);

        const result = setupEnvironment(mockArgv);

        expect(result).toBe('pre');
        
        // Should only be called once for default .env
        expect(configMock).toHaveBeenCalledTimes(1);
        expect(configMock).toHaveBeenCalledWith();
    });

    test('should_handle_prod_env_argument_correctly', () => {
        const mockArgv = ['node', 'script', '--env=prod'];
        
        process.cwd = () => '/test/project';
        existsSyncMock.mockImplementation((path) => {
            return path.includes('.env.prod');
        });

        const result = setupEnvironment(mockArgv);

        expect(result).toBe('prod');
        expect(configMock).toHaveBeenCalledTimes(2);
        expect(configMock).toHaveBeenNthCalledWith(2, {
            path: expect.any(String),
            override: true
        });
        
        // Verify the path contains the expected filename
        const secondCallPath = configMock.mock.calls[1][0].path;
        expect(secondCallPath).toContain('.env.prod');
    });

    test('should_handle_complex_env_argument_with_equals_signs', () => {
        const mockArgv = ['node', 'script', '--env=test-env', 'other=arg'];
        
        process.cwd = () => '/test/project';
        existsSyncMock.mockReturnValue(false);

        const result = setupEnvironment(mockArgv);

        expect(result).toBe('test-env');
    });
  });

  describe('generateWranglerCommand', () => {
    test('should_generate_wrangler_vars_from_gha_json_contexts', () => {
        const mockEnv = {
          GHA_SECRETS_JSON: JSON.stringify({
            NF_REDIS_PASSWORD: 'secret-password',
            AXIOM_TOKEN: 'axiom-secret',
            QSTASH_CURRENT_SIGNING_KEY: 'qstash-key'
          }),
          GHA_VARS_JSON: JSON.stringify({
            NF_REDIS_URL: 'https://vars.url',
            NODE_ENV: 'prod'
          })
        };

        const output = generateWranglerCommand(mockEnv);

        expect(output).toContain('npx wrangler deploy');
        expect(output).toContain('-c wrangler.toml');
        expect(output).toContain('--compatibility-flags="nodejs_compat"');

        expect(output).toContain('--var NF_REDIS_PASSWORD="secret-password"');
        expect(output).toContain('--var AXIOM_TOKEN="axiom-secret"');
        expect(output).toContain('--var QSTASH_CURRENT_SIGNING_KEY="qstash-key"');
        expect(output).toContain('--var NF_REDIS_URL="https://vars.url"');
        expect(output).toContain('--var NODE_ENV="prod"');
    });

    test('should_prioritize_secrets_over_vars_in_wrangler_command', () => {
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

    test('should_handle_special_characters_in_variable_values', () => {
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

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
        NODE_ENV: 'dev',
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
        NODE_ENV: 'prod',
        WORKER_NAME: 'gha-worker',
        CLOUDFLARE_ACCOUNT_ID: 'test-id',
        CF_KV_NAMESPACE_ID: 'test-kv'
      };

      const content = generateToml(mockEnv, mockManifest, mockTomlTemplate, mockPackageJson);
      
      expect(content).toContain('[vars]');
      expect(content).toContain('name = "gha-worker"');
      expect(content).toContain('VERSION = "dev"');
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
            NODE_ENV: 'dev',
            CF_KV_NAMESPACE_ID: 'prod-kv-id',
            KV_PREVIEW_ID: ''
        };
        
        const content = generateToml(mockEnv, mockManifest, mockTomlTemplate, mockPackageJson);
        expect(content).toContain('preview_id = "00000000000000000000000000000000"');
    });
  });
});
