import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
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
      get: jest.fn().mockResolvedValue('mock-value'),
      set: jest.fn().mockResolvedValue(true),
      ping: jest.fn().mockResolvedValue(true),
      listKeys: jest.fn().mockResolvedValue(['key1', 'key2']),
      disconnect: jest.fn()
    };

    // Create mock CacheService instance
    const mockInstance = {
      initialize: jest.fn().mockResolvedValue(undefined),
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      primaryProvider: mockProvider,
      getCurrentProvider: jest.fn().mockReturnValue('cloudflare'),
      get: jest.fn((key, type, options) => mockProvider.get(key, type, options)),
      set: jest.fn((key, value, ttl, options) => mockProvider.set(key, value, ttl, options)),
      listKeys: jest.fn((prefix, ctx) => mockProvider.listKeys(prefix, ctx)),
      destroy: jest.fn().mockResolvedValue(undefined)
    };

    // Inject mock instance
    __test_setCacheServiceInstance(mockInstance);

    // Suppress console output during tests
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console spies
    jest.restoreAllMocks();
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
