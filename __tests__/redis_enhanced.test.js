import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// Mock redis-on-workers first (before importing from src/index.js)
vi.mock('redis-on-workers', () => ({
  createRedis: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('OK'),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
  __mockSend: vi.fn(),
}));

// Mock logger (before importing from src/index.js)
vi.mock('../src/logger.js', () => {
  const mockLogger = {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    success: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn(),
    version: 'dev',
    env: 'test',
  };
  mockLogger.child = vi.fn().mockReturnValue(mockLogger);
  
  return {
    logger: mockLogger,
    configureBaseLoggerTransport: vi.fn(),
    sanitizeLogData: vi.fn(data => data),
    flushLogs: vi.fn().mockResolvedValue(undefined),
    flushGlobalLoggerBuffer: vi.fn().mockResolvedValue(undefined),
    isTestEnvironment: true,
    VERSION: 'dev',
  };
});

// Mock CacheService class (NEW)
vi.mock('../src/cache/CacheService.js', async () => {
  const actual = await vi.importActual('../src/cache/CacheService.js');
  return {
    ...actual,
    CacheService: vi.fn(),
  };
});

// Import after mocking
import {
  executeRedis,
  executeRedisScan,
  checkRedisHealth,
  __test_resetCacheService,
  __test_setCacheServiceInstance
} from '../src/index.js';
import { CacheService } from '../src/cache/CacheService.js'; // Import mocked class
import { logger } from '../src/logger.js'; // Import mocked logger

describe('CacheService Integration', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  
  // Mock provider (updated in beforeEach)
  let mockProvider;

  // Stable mock instance that delegates to the current mockProvider
  const mockInstance = {
    initialize: vi.fn().mockResolvedValue(undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // Dynamic property to access current mockProvider
    get primaryProvider() { return mockProvider; },
    getCurrentProvider: vi.fn().mockReturnValue('cloudflare'),
    get: vi.fn((key, type, options) => mockProvider.get(key, type, options)),
    set: vi.fn((key, value, ttl, options) => mockProvider.set(key, value, ttl, options)),
    listKeys: vi.fn((prefix, ctx) => mockProvider.listKeys(prefix, ctx)),
    destroy: vi.fn().mockResolvedValue(undefined),
    isInvalid: false
  };

  beforeEach(() => {
    // Ensure logger.child returns logger
    if (logger && logger.child) {
      logger.child.mockReturnValue(logger);
    }

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

    // Setup Mock Implementation for CacheService class
    // Always return the SAME instance because redisCompat.js caches it
    CacheService.mockImplementation(() => mockInstance);

    // Inject mock instance (legacy)
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
