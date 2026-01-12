import { vi, describe, test, expect, beforeEach } from 'vitest';
import fs from 'fs';

// Mock modules
const execSyncMock = vi.fn();
const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
const spawnMock = vi.fn(() => ({
    on: vi.fn((event, callback) => {
        if (event === 'exit') callback(0);
    })
}));

vi.mock('child_process', async () => {
  const actual = await import('child_process');
  return {
    ...actual,
    execSync: execSyncMock,
    spawnSync: spawnSyncMock,
    spawn: spawnMock
  };
});

vi.mock('dotenv', async () => {
  const actual = await import('dotenv');
  return {
    ...actual,
    default: {
      config: vi.fn(),
      parse: vi.fn(() => ({}))
    }
  };
});

vi.mock('fs', async () => {
  const actual = await import('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(),
      existsSync: vi.fn(),
      unlinkSync: vi.fn()
    }
  };
});

// Dynamic import
const { extractSecretsFromEnv, generateSecretsJson, uploadSecrets, deployWorker } = await import('../../scripts/deploy-with-secrets.js');

describe('deploy-with-secrets.js (Unit)', () => {
    const mockManifest = {
        config: {
            env: {
                SECRET_A: { type: 'string' },
                CONFIG_B: { type: 'number' },
                NODE_ENV: { type: 'string' }
            }
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Get the mocked fs
    });

    describe('extractSecretsFromEnv', () => {
        test('should extract string-type env vars and exclude blacklist', async () => {
            const fsModule = await import('fs');
            fsModule.default.readFileSync.mockReturnValue(JSON.stringify(mockManifest));
            fsModule.default.existsSync.mockReturnValue(true);

            const mockEnv = {
                SECRET_A: 'value-a',
                CONFIG_B: '123',
                NODE_ENV: 'prod',
                SIGNATURE_EXPIRATION_WINDOW: '900',
                OTHER: 'ignored'
            };

            const secrets = extractSecretsFromEnv(mockEnv);

            expect(secrets).toEqual({
                SECRET_A: 'value-a'
            });
        });
    });

    describe('uploadSecrets', () => {
        test('should call wrangler secret bulk with the correct file path', () => {
            const jsonPath = 'dummy/secrets.json';
            uploadSecrets(jsonPath);

            const call = spawnSyncMock.mock.calls[0];
            expect(call[0]).toMatch(/npx(\.cmd)?$/);
            expect(call[1]).toEqual(['wrangler', 'secret', 'bulk', jsonPath]);
            expect(call[2]).toEqual(expect.any(Object));
        });
    });

    describe('deployWorker', () => {
        test('should call wrangler deploy without --var', () => {
            deployWorker();

            expect(execSyncMock).toHaveBeenCalledWith(
                expect.stringContaining('npx wrangler deploy'),
                expect.any(Object)
            );
        });
    });
});
