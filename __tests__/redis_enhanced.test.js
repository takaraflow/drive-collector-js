import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    child: vi.fn().mockReturnThis(),
    configure: vi.fn(),
    version: 'dev',
    env: 'test',
  },
  configureBaseLoggerTransport: vi.fn(),
  sanitizeLogData: vi.fn(data => data),
  flushLogs: vi.fn().mockResolvedValue(undefined),
  flushGlobalLoggerBuffer: vi.fn().mockResolvedValue(undefined),
  isTestEnvironment: true,
  VERSION: 'dev',
}));

vi.mock('redis-on-workers', () => ({
  createRedis: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('OK'),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
  __mockSend: vi.fn(),
}));

import { 
  executeRedis, 
  executeRedisScan, 
  checkRedisHealth, 
  __test_resetCacheService, 
  __test_setCacheServiceInstance 
} from '../src/index.js';

describe('CacheService Integration', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  
  // Mock provider
  let mockProvider;

  beforeEach(() => {
    // Reset cache service instance using the test hook
    if (__test_resetCacheService) {
      __test_resetCacheService();
    }
    
    // Setup mock provider
    mockProvider = {
      get: vi.fn().mockResolvedValue('mock-value'),
      set: vi.fn().mockResolvedValue(true),
      ping: vi.fn().mockResolvedValue(true),
      listKeys: vi.fn().mockResolvedValue(['key1', 'key2']),
      disconnect: vi.fn()
    };

    // Create mock CacheService instance
    const mockInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      primaryProvider: mockProvider,
      getCurrentProvider: vi.fn().mockReturnValue('cloudflare'),
      get: vi.fn((key, type, options) => mockProvider.get(key, type, options)),
      set: vi.fn((key, value, ttl, options) => mockProvider.set(key, value, ttl, options)),
      listKeys: vi.fn((prefix, ctx) => mockProvider.listKeys(prefix, ctx)),
      destroy: vi.fn().mockResolvedValue(undefined)
    };

    // Inject mock instance
    __test_setCacheServiceInstance(mockInstance);

    // Suppress console output during tests
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console spies
    vi.restoreAllMocks();
  });

  describe('executeRedis', () => {
    test('should_use_CACHE_PROVIDERS_for_get_operation', async () => {
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const result = await executeRedis('_redis_get', env, 'test-key');
      expect(result).toBe('mock-value');
    });

    test('should_handle_redis_get_returning_null', async () => {
      mockProvider.get.mockResolvedValueOnce(null);
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const result = await executeRedis('_redis_get', env, 'nonexistent-key');
      expect(result).toBeNull();
    });

    test('should_handle_redis_put_operation', async () => {
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      await executeRedis('_redis_put', env, 'key', 'value');
      expect(mockProvider.set).toHaveBeenCalledWith('key', 'value', 3600, {});
    });
    
    test('should_handle_redis_put_with_json_serialized_value', async () => {
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const obj = { foo: 'bar' };
      await executeRedis('_redis_put', env, 'key', obj);
      expect(mockProvider.set).toHaveBeenCalledWith('key', JSON.stringify(obj), 3600, {});
    });

    test('should_throw_error_when_redis_operation_fails', async () => {
      mockProvider.get.mockRejectedValueOnce(new Error('Connection failed'));
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      await expect(executeRedis('_redis_get', env, 'key')).rejects.toThrow('Connection failed');
    });

    test('should_throw_error_when_CACHE_PROVIDERS_not_configured', async () => {
      const env = {};
      await expect(executeRedis('_redis_get', env, 'key')).rejects.toThrow('CACHE_PROVIDERS not configured');
    });
  });

  describe('executeRedisScan', () => {
    test('should_scan_keys_with_prefix_correctly', async () => {
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const result = await executeRedisScan(env, 'prefix:');
      expect(result.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
    });

    test('should_handle_empty_scan_results', async () => {
      mockProvider.listKeys.mockResolvedValueOnce([]);
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const result = await executeRedisScan(env, 'nonexistent:');
      expect(result.keys).toEqual([]);
    });

    test('should_throw_error_when_CACHE_PROVIDERS_not_configured', async () => {
      const env = {};
      await expect(executeRedisScan(env, 'prefix:')).rejects.toThrow('CACHE_PROVIDERS not configured');
    });
  });

  describe('checkRedisHealth', () => {
    test('should_return_true_when_provider_is_healthy', async () => {
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const ctx = {};
      
      const result = await checkRedisHealth(env, ctx);
      expect(result).toBe(true);
      expect(mockProvider.ping).toHaveBeenCalled();
    });

    test('should_return_false_when_ping_fails', async () => {
      mockProvider.ping.mockRejectedValueOnce(new Error('Connection failed'));
      const env = { CACHE_PROVIDERS: '{"cloudflare": {}}' };
      const ctx = {};
      
      const result = await checkRedisHealth(env, ctx);
      expect(result).toBe(false);
    });

    test('should_return_false_when_CACHE_PROVIDERS_not_configured', async () => {
      const env = {};
      const ctx = {};
      
      const result = await checkRedisHealth(env, ctx);
      expect(result).toBe(false);
    });
  });
});