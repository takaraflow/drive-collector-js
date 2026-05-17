import { describe, expect, test, vi } from 'vitest';
import {
  loadSmokeConfig,
  normalizeSmokeConfig,
  parseArgs,
  redactForLog,
  runDriveSupportSmoke
} from '../../scripts/drive-support-smoke.js';

describe('drive-support-smoke script', () => {
  test('should parse config objects keyed by provider type', () => {
    expect(normalizeSmokeConfig({
      mega: { user: 'user@example.com', pass: 'secret' },
      webdav: { url: 'https://dav.example.com', user: 'u', pass: 'p' }
    })).toEqual([
      { type: 'mega', config: { user: 'user@example.com', pass: 'secret' } },
      { type: 'webdav', config: { url: 'https://dav.example.com', user: 'u', pass: 'p' } }
    ]);
  });

  test('should parse providers array config', () => {
    expect(normalizeSmokeConfig({
      providers: [
        { type: 'dropbox', config: { token: 'opaque-token' } }
      ]
    })).toEqual([
      { type: 'dropbox', config: { token: 'opaque-token' } }
    ]);
  });

  test('should prefer explicit cli config file over env json', () => {
    const readFile = vi.fn(() => '{"webdav":{"url":"https://dav.example.com"}}');
    const loaded = loadSmokeConfig({
      options: { configFile: '/tmp/ignored.json' },
      env: { DRIVE_SMOKE_CONFIG_JSON: '{"mega":{"user":"u","pass":"p"}}' },
      readFile
    });

    expect(loaded.source).toBe('/tmp/ignored.json');
    expect(loaded.entries).toEqual([{ type: 'webdav', config: { url: 'https://dav.example.com' } }]);
    expect(readFile).toHaveBeenCalledWith('/tmp/ignored.json', 'utf8');
  });

  test('should load config from env json when no cli config is provided', () => {
    const readFile = vi.fn();
    const loaded = loadSmokeConfig({
      options: {},
      env: { DRIVE_SMOKE_CONFIG_JSON: '{"mega":{"user":"u","pass":"p"}}' },
      readFile
    });

    expect(loaded.source).toBe('DRIVE_SMOKE_CONFIG_JSON');
    expect(loaded.entries).toEqual([{ type: 'mega', config: { user: 'u', pass: 'p' } }]);
    expect(readFile).not.toHaveBeenCalled();
  });

  test('should reject cli options missing values', () => {
    expect(() => parseArgs(['--config-file'])).toThrow('requires a value');
    expect(() => parseArgs(['--types', '--require-config'])).toThrow('requires a value');
  });

  test('should skip without config by default', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    const result = await runDriveSupportSmoke({
      env: {},
      stdout,
      stderr,
      loadFactory: vi.fn()
    });

    expect(result).toMatchObject({ exitCode: 0, status: 'skipped' });
    expect(stdout.mock.calls[0][0]).toContain('SKIP');
    expect(stderr).not.toHaveBeenCalled();
  });

  test('should fail without config when required', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    const result = await runDriveSupportSmoke({
      argv: ['--require-config'],
      env: {},
      stdout,
      stderr,
      loadFactory: vi.fn()
    });

    expect(result).toMatchObject({ exitCode: 1, status: 'failed' });
    expect(stderr.mock.calls[0][0]).toContain('FAIL');
    expect(stdout).not.toHaveBeenCalled();
  });

  test('should validate selected configured providers', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const factory = createFactory({
      mega: { success: true, supportLevel: 'stable' },
      dropbox: { success: true, supportLevel: 'advanced' }
    });

    const result = await runDriveSupportSmoke({
      argv: ['--types', 'dropbox'],
      env: {
        DRIVE_SMOKE_CONFIG_JSON: JSON.stringify({
          mega: { user: 'u', pass: 'p' },
          dropbox: { token: 'opaque-token' }
        })
      },
      factory,
      stdout,
      stderr
    });

    expect(result).toMatchObject({ exitCode: 0, status: 'passed' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ type: 'dropbox', success: true, supportLevel: 'advanced' });
    expect(stdout.mock.calls.flat().join('\n')).toContain('PASS dropbox');
    expect(stderr).not.toHaveBeenCalled();
  });

  test('should fail and redact secrets from validation details', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const factory = createFactory({
      dropbox: {
        supportLevel: 'advanced',
        success: false,
        reason: 'ERROR',
        details: 'bad token="very-secret-token" access_token":"secret-access"'
      }
    });

    const result = await runDriveSupportSmoke({
      env: {
        DRIVE_SMOKE_CONFIG_JSON: JSON.stringify({
          dropbox: { token: 'very-secret-token' }
        })
      },
      factory,
      stdout,
      stderr
    });

    const output = stderr.mock.calls.flat().join('\n');
    expect(result).toMatchObject({ exitCode: 1, status: 'failed' });
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('very-secret-token');
    expect(output).not.toContain('secret-access');
  });

  test('should parse cli config arguments', () => {
    expect(parseArgs(['--config-file', 'drives.json', '--types=mega,webdav', '--require-config']))
      .toMatchObject({
        configFile: 'drives.json',
        types: ['mega', 'webdav'],
        requireConfig: true
      });
  });

  test('should redact common secret shapes', () => {
    expect(redactForLog('token="abc" access_token":"xyz" Authorization: Bearer aaa.bbb'))
      .toBe('token="[REDACTED]" access_token":"[REDACTED]" Authorization: Bearer [REDACTED]');
  });
});

function createFactory(definitions) {
  return {
    isSupported: vi.fn(type => Boolean(definitions[type])),
    getProvider: vi.fn(type => {
      const definition = definitions[type];
      return {
        getInfo: () => ({ type, supportLevel: definition.supportLevel }),
        validateConfig: vi.fn().mockResolvedValue({
          success: definition.success,
          reason: definition.reason,
          details: definition.details
        })
      };
    })
  };
}
