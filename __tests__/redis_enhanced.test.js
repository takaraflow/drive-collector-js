import { jest } from '@jest/globals';
import {
  executeRedis,
  executeRedisScan,
  checkRedisHealth,
  __test_setRedisClient
} from '../src/index.js';
import { clearNFCacheClient } from '../src/cache/client-factory.js';

// Helper function to advance timers and flush promise queue
async function advanceTimers(ms) {
  jest.advanceTimersByTime(ms);
  // 等待所有 Promise 微任务完成
  await Promise.resolve();
  await Promise.resolve(); // 双重等待确保队列清空
}

// Globally scoped mock client for src/index.js to retrieve
let currentTestMockClient;

// src/index.js expects global.__test_getRedisClient to return the mock.
global.__test_getRedisClient = jest.fn(() => currentTestMockClient);

jest.mock('../src/cache/client-factory.js', () => {
  const factory = {
    getNFCacheClient: jest.fn(() => {
      // This factory will return the globally managed currentTestMockClient
      // It's expected that currentTestMockClient is set in beforeEach
      return currentTestMockClient;
    }),
    clearNFCacheClient: jest.fn(() => {
      // Reset the mock behaviors of the current global mock client
      if (currentTestMockClient) {
        currentTestMockClient.connect.mockResolvedValue(undefined);
        currentTestMockClient.get.mockResolvedValue(null);
        currentTestMockClient.set.mockResolvedValue('OK');
        currentTestMockClient.scan.mockResolvedValue(['0', []]);
        currentTestMockClient.ping.mockResolvedValue('PONG');
        currentTestMockClient.disconnect.mockResolvedValue(undefined);
      }
    })
  };
  return factory;
});

describe('Redis TCP Adaptation', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  
  beforeEach(async () => {
    // Create a fresh mock client for each test
    currentTestMockClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      scan: jest.fn().mockResolvedValue(['0', []]),
      ping: jest.fn().mockResolvedValue('PONG'),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };
    
    // Set the mock client in src/index.js's internal state
    __test_setRedisClient(currentTestMockClient); 

    // Clear any previous mock calls if this mock was reused due to some quirk
    for (const key in currentTestMockClient) {
      if (typeof currentTestMockClient[key]?.mockClear === 'function') {
        currentTestMockClient[key].mockClear();
      }
    }
    
    // Reset internal cache client factory state
    const { clearNFCacheClient: clearFactoryCache } = await import('../src/cache/client-factory.js');
    clearFactoryCache();

    // Suppress console output during tests
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Restore console spies
    if (consoleLogSpy) consoleLogSpy.mockRestore();
    if (consoleWarnSpy) consoleWarnSpy.mockRestore();
    if (consoleErrorSpy) consoleErrorSpy.mockRestore();
    
    // Clear the mock client in src/index.js's internal state
    __test_setRedisClient(null); 
    currentTestMockClient = null; // Also clear the global reference
    
    // Restore timers
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('executeRedis', () => {
    test('should_use_nf_redis_url_and_password_for_tls_connection', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.get.mockResolvedValueOnce('value');
      const result = await executeRedis('_redis_get', env, 'key');
      expect(result).toBe('value');
      expect(currentTestMockClient.get).toHaveBeenCalledWith('key');
    });

    test('should_handle_redis_get_returning_null', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.get.mockResolvedValueOnce(null);
      const result = await executeRedis('_redis_get', env, 'key');
      expect(result).toBeNull();
    });

    test('should_handle_redis_put_operation', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.set.mockResolvedValueOnce('OK');
      await executeRedis('_redis_put', env, 'key', 'value');
      expect(currentTestMockClient.set).toHaveBeenCalledWith('key', 'value');
    });
    
    test('should_handle_redis_put_with_json_serialized_value', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.set.mockResolvedValueOnce('OK');
      const obj = { foo: 'bar' };
      await executeRedis('_redis_put', env, 'key', obj);
      expect(currentTestMockClient.set).toHaveBeenCalledWith('key', JSON.stringify(obj));
    });

    test('should_throw_error_when_redis_operation_fails', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.get.mockRejectedValueOnce(new Error('Connection failed'));
      await expect(executeRedis('_redis_get', env, 'key')).rejects.toThrow('Connection failed');
    });
  });

    test('should_use_send_command_with_match_count_when_available', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      // 为此测试添加 send 方法
      currentTestMockClient.send = jest.fn()
        .mockResolvedValueOnce(['10', ['key1']])
        .mockResolvedValueOnce(['0', ['key2']]);
      // scan 方法应该不被调用
      currentTestMockClient.scan.mockClear();

      const result = await executeRedisScan(env, 'prefix');
      
      expect(result.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
      // 验证 send 是否被正确调用，带有 MATCH 和 COUNT 关键字
      expect(currentTestMockClient.send).toHaveBeenCalledWith('SCAN', '0', 'MATCH', 'prefix*', 'COUNT', 100);
      expect(currentTestMockClient.send).toHaveBeenCalledWith('SCAN', '10', 'MATCH', 'prefix*', 'COUNT', 100);
      
      // 清理 send 方法以免影响其他测试
      delete currentTestMockClient.send;
    });

  describe('executeRedisScan', () => {
    test('should_scan_redis_keys_with_prefix_correctly', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.scan.mockResolvedValueOnce(['10', ['key1']]).mockResolvedValueOnce(['0', ['key2']]);
      const result = await executeRedisScan(env, 'prefix');
      expect(result.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
      // 验证调用参数是否包含 MATCH 和 COUNT
      // 注意：mock 的调用参数取决于 src/index.js 中实际调用的 scan 还是 send
      // 由于我们 mock 的是 scan 方法，且 src/index.js 中优先使用 send，
      // 但如果 mock client 没有 send 方法（这里只有 scan），就会走到 scan 分支。
      // 在这个测试 setup 中，currentTestMockClient 没有 send 方法。
      expect(currentTestMockClient.scan).toHaveBeenCalledWith('0', 'prefix*', 100);
    });

    test('should_handle_empty_redis_scan_results', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      currentTestMockClient.scan.mockResolvedValueOnce(['0', []]);
      const result = await executeRedisScan(env, 'prefix');
      expect(result.keys).toEqual([]);
    });
  });

  describe('checkRedisHealth', () => {
    test('should use PING command for NF Redis and succeed', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      const ctx = {};
      
      currentTestMockClient.ping.mockResolvedValueOnce('PONG');
      
      const result = await checkRedisHealth(env, ctx);
      expect(result).toBe(true);
      expect(currentTestMockClient.ping).toHaveBeenCalled();
    });

    test('should return false when PING fails', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      const ctx = {};
      
      currentTestMockClient.ping.mockRejectedValueOnce(new Error('Connection failed'));
      
      const mockExecutor = jest.fn().mockRejectedValue(new Error('Provider failed'));
      
      const result = await checkRedisHealth(env, ctx, mockExecutor);
      expect(result).toBe(false);
    });

    test('should fallback to _kv_get when PING fails', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      const ctx = {};
      const mockExecutor = jest.fn().mockResolvedValue(true);
      
      currentTestMockClient.ping.mockRejectedValueOnce(new Error('PING failed'));
      
      const result = await checkRedisHealth(env, ctx, mockExecutor);
      expect(result).toBe(true);
      expect(mockExecutor).toHaveBeenCalledWith('_kv_get', env, ctx, 'healthcheck_ping');
    });
  });
});