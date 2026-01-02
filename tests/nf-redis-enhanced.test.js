import { jest } from '@jest/globals';
import {
  executeRedis,
  executeRedisScan,
  checkRedisHealth,
  __test_setRedisClient
} from '../src/index.js';
import { createRedis, __mockSend } from 'redis-on-workers';

// Helper function to advance timers and flush promise queue
async function advanceTimers(ms) {
  jest.advanceTimersByTime(ms);
  // 等待所有 Promise 微任务完成
  await Promise.resolve();
  await Promise.resolve(); // 双重等待确保队列清空
}

describe('Redis TCP Adaptation', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    __mockSend.mockReset();
    if (typeof __test_setRedisClient === 'function') {
      __test_setRedisClient(null);
    }
    
    const mockClient = createRedis({});
    if (typeof __test_setRedisClient === 'function') {
      __test_setRedisClient(mockClient);
    }

    // Suppress console output during tests
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (typeof __test_setRedisClient === 'function') {
      __test_setRedisClient(null);
    }
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('executeRedis', () => {
    test('should use createRedis with rediss:// protocol (TLS)', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockResolvedValueOnce('value');
      const result = await executeRedis('_redis_get', env, 'key');
      expect(result).toBe('value');
      expect(__mockSend).toHaveBeenCalledWith('GET', 'key');
    });

    test('should handle GET returning null', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockResolvedValueOnce(null);
      const result = await executeRedis('_redis_get', env, 'key');
      expect(result).toBeNull();
    });

    test('should handle PUT operation', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockResolvedValueOnce('OK');
      await executeRedis('_redis_put', env, 'key', 'value');
      expect(__mockSend).toHaveBeenCalledWith('SET', 'key', 'value');
    });
    
    test('should handle PUT with JSON value', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockResolvedValueOnce('OK');
      const obj = { foo: 'bar' };
      await executeRedis('_redis_put', env, 'key', obj);
      expect(__mockSend).toHaveBeenCalledWith('SET', 'key', JSON.stringify(obj));
    });

    test('should throw on error', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockRejectedValueOnce(new Error('Connection failed'));
      await expect(executeRedis('_redis_get', env, 'key')).rejects.toThrow('Connection failed');
    });

    test('should retry on ECONNRESET and succeed', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce('value');
      const resultPromise = executeRedis('_redis_get', env, 'key');
      for (let index = 0; index < 10; index++) { await advanceTimers(100); }
      const result = await resultPromise;
      expect(result).toBe('value');
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });

    test('should retry on SocketError and succeed', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockRejectedValueOnce(new Error('SocketError: Connection reset')).mockResolvedValueOnce('OK');
      const resultPromise = executeRedis('_redis_put', env, 'key', 'val');
      for (let i = 0; i < 10; i++) { await advanceTimers(100); }
      const result = await resultPromise;
      expect(result).toBe(true);
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });

    test('should exhaust retries and throw on persistent ECONNRESET', async () => {
      const env = { NF_REDIS_URL: 'redis://example.com:6379', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockRejectedValue(new Error('ECONNRESET'));
      const resultPromise = executeRedis('_redis_get', env, 'key');
      for (let i = 0; i < 20; i++) { await advanceTimers(100); }
      await expect(resultPromise).rejects.toThrow('ECONNRESET');
      expect(__mockSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('executeRedisScan', () => {
    test('should scan keys properly', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockResolvedValueOnce(['10', ['key1']]).mockResolvedValueOnce(['0', ['key2']]);
      const result = await executeRedisScan(env, 'prefix');
      expect(result.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
    });

    test('should retry scan on network error', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      __mockSend.mockRejectedValueOnce(new Error('network error')).mockResolvedValueOnce(['0', ['key1']]);
      const resultPromise = executeRedisScan(env, 'prefix');
      for (let i = 0; i < 10; i++) { await advanceTimers(100); }
      const result = await resultPromise;
      expect(result.keys).toEqual([{ name: 'key1' }]);
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkRedisHealth', () => {
    test('should use _kv_get on a healthcheck key and succeed', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      const ctx = {};
      const mockExecutor = jest.fn().mockResolvedValue(true);
      const result = await checkRedisHealth(env, ctx, mockExecutor);
      expect(result).toBe(true);
      expect(mockExecutor).toHaveBeenCalledWith('_kv_get', env, ctx, 'healthcheck_ping');
    });

    test('should return false when executor fails', async () => {
      const env = { NF_REDIS_URL: 'rediss://example.com:6380', NF_REDIS_PASSWORD: 'pass' };
      const ctx = {};
      const mockExecutor = jest.fn().mockRejectedValue(new Error('Provider failed'));
      const result = await checkRedisHealth(env, ctx, mockExecutor);
      expect(result).toBe(false);
    });
  });
});