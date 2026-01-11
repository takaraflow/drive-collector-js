import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { parseCacheConfig } from '../src/utils/configParser.js';

describe('Cache System - configParser', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('should parse valid json config', () => {
    const json = '[{"name":"test","type":"redis"}]';
    const result = parseCacheConfig(json, {});
    expect(result).toEqual([{ name: 'test', type: 'redis' }]);
  });

  test('should return null for empty input', () => {
    expect(parseCacheConfig(null, {})).toBeNull();
    expect(parseCacheConfig(undefined, {})).toBeNull();
    expect(parseCacheConfig('', {})).toBeNull();
  });

  test('should interpolate env vars', () => {
    const env = { CF_ACCOUNT_ID: '12345', REDIS_HOST: 'localhost' };
    const json = '[{"accountId":"${CF_ACCOUNT_ID}","host":"${REDIS_HOST}"}]';
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{ accountId: '12345', host: 'localhost' }]);
  });

  test('should return empty string for missing env var', () => {
    const env = {};
    const json = '[{"token":"${MISSING_VAR}"}]';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{ token: '' }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MISSING_VAR'));
    warnSpy.mockRestore();
  });

  test('should handle nested objects', () => {
    const env = { HOST: 'redis.example.com' };
    const json = '[{"config":{"host":"${HOST}","port":6379}}]';
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{ config: { host: 'redis.example.com', port: 6379 } }]);
  });

  test('should handle non string values unchanged', () => {
    const json = '{"num":123,"bool":true,"null":null}';
    const result = parseCacheConfig(json, {});
    expect(result).toEqual({ num: 123, bool: true, null: null });
  });

  test('should parse complex provider config', () => {
    const env = { MY_PASSWORD: 'secret123' };
    const json = '[{"name":"Primary","type":"redis","priority":1,"host":"redis.example.com","port":6379,"password":"${MY_PASSWORD}","tls":{"enabled":true,"rejectUnauthorized":false}}]';
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{
      name: 'Primary',
      type: 'redis',
      priority: 1,
      host: 'redis.example.com',
      port: 6379,
      password: 'secret123',
      tls: { enabled: true, rejectUnauthorized: false }
    }]);
  });
});

describe('Cache System - CacheService basic behavior', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.123456789);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = originalEnv;
  });

  test('should initialize with empty config', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    expect(service.primaryProvider).toBeNull();
    expect(service.currentProviderName).toBe('MemoryCache');
    expect(service.isInitialized).toBe(true);
  });

  test('should not reinitialize if already initialized', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    await service.initialize();
    expect(service.isInitialized).toBe(true);
  });

  test('should have correct default values', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    expect(service.maxFailuresBeforeFailover).toBe(3);
    expect(service.failureCount).toBe(0);
    expect(service.isFailoverMode).toBe(false);
  });

  test('should accept custom options', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService({ env: { CACHE_PROVIDERS: '[]' }, maxFailuresBeforeFailover: 5 });
    expect(service.maxFailuresBeforeFailover).toBe(5);
  });

  test('should get current provider name with no providers', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    expect(service.getCurrentProvider()).toBe('MemoryCache');
  });

  test('should get connection info with no providers', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    const info = service.getConnectionInfo();
    expect(info.provider).toBe('MemoryCache');
  });


  test('should not fail get when no primary provider', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    const result = await service.get('key1');
    expect(result).toBeNull();
  });

  test('should not fail set when no primary provider', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    const result = await service.set('key1', 'value1');
    expect(result).toBe(true);
  });

  test('should not fail delete when no primary provider', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    const result = await service.delete('key1');
    expect(result).toBe(true);
  });

  test('should not fail listKeys when no primary provider', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    const result = await service.listKeys('prefix');
    expect(result).toEqual([]);
  });

  test('should not fail destroy when no providers', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = {};
    await service.initialize();
    await expect(service.destroy()).resolves.not.toThrow();
  });

  test('should handle invalid CACHE_PROVIDERS JSON gracefully', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = { CACHE_PROVIDERS: 'invalid json' };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await service.initialize();
    expect(service.primaryProvider).toBeNull();
    expect(service.currentProviderName).toBe('MemoryCache');
    warnSpy.mockRestore();
  });

  test('should skip providers without name', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = { CACHE_PROVIDERS: '[{"type":"redis","priority":1}]' };
    await service.initialize();
    expect(service.primaryProvider).toBeNull();
  });

  test('should skip unknown provider types', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = { CACHE_PROVIDERS: '[{"name":"Unknown","type":"unknown-type"}]' };
    await service.initialize();
    expect(service.primaryProvider).toBeNull();
  });

  test('should handle empty provider array', async () => {
    const { CacheService } = await import('../src/cache/CacheService.js');
    const service = new CacheService();
    service.env = { CACHE_PROVIDERS: '[]' };
    await service.initialize();
    expect(service.primaryProvider).toBeNull();
    expect(service.providerList).toEqual([]);
  });
});
