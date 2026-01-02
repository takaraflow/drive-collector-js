import { jest } from '@jest/globals';
import { executeRedis, executeRedisScan, checkRedisHealth, logger } from '../src/index.js';
import { __mockSend } from 'redis-on-workers';

// Mock logger
logger.warn = jest.fn();
logger.info = jest.fn();
logger.error = jest.fn();
logger.debug = jest.fn();

// Mock timers to speed up retry tests
jest.useFakeTimers();

// 辅助函数：推进时间并刷新 Promise 队列
async function advanceTimers(ms) {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Redis TCP Adaptation', () => {
  beforeEach(() => {
    // IMPORTANT: Reset mockSend
    __mockSend.mockReset();
    logger.warn.mockClear();
    logger.info.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    jest.clearAllTimers();
  });

  describe('executeRedis', () => {
    test('should use createRedis with rediss:// protocol (TLS)', async () => {
      const env = {
        NF_REDIS_URL: 'rediss://example.com:6380',
        NF_REDIS_PASSWORD: 'pass'
      };
      
      __mockSend.mockResolvedValueOnce('value');

      const result = await executeRedis('_redis_get', env, 'key');
      expect(result).toBe('value');
      
      expect(__mockSend).toHaveBeenCalledWith('GET', 'key');
    });

    test('should handle GET returning null', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };
      
      __mockSend.mockResolvedValueOnce(null);

      const result = await executeRedis('_redis_get', env, 'key');
      expect(result).toBeNull();
    });

    test('should handle PUT operation', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };
      
      __mockSend.mockResolvedValueOnce('OK');

      await executeRedis('_redis_put', env, 'key', 'value');
      
      expect(__mockSend).toHaveBeenCalledWith('SET', 'key', 'value');
    });
    
    test('should handle PUT with JSON value', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };
      
      __mockSend.mockResolvedValueOnce('OK');

      const obj = { foo: 'bar' };
      await executeRedis('_redis_put', env, 'key', obj);
      
      expect(__mockSend).toHaveBeenCalledWith('SET', 'key', JSON.stringify(obj));
    });

    test('should throw on error', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };
      
      __mockSend.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(executeRedis('_redis_get', env, 'key'))
        .rejects.toThrow('Connection failed');
    });

    test('should retry on ECONNRESET and succeed', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };

      __mockSend
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce('value');

      const resultPromise = executeRedis('_redis_get', env, 'key');

      // 关键：循环推进直到 Promise 完成
      for (let i = 0; i < 10; i++) {
        await advanceTimers(100);
      }

      const result = await resultPromise;

      expect(result).toBe('value');
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });

    test('should retry on SocketError and succeed', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };

      __mockSend
        .mockRejectedValueOnce(new Error('SocketError: Connection reset'))
        .mockResolvedValueOnce('OK');

      const resultPromise = executeRedis('_redis_put', env, 'key', 'val');

      for (let i = 0; i < 10; i++) {
        await advanceTimers(100);
      }

      const result = await resultPromise;

      expect(result).toBe(true);
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });

    test('should exhaust retries and throw on persistent ECONNRESET', async () => {
      const env = {
        NF_REDIS_URL: 'redis://example.com:6379',
        NF_REDIS_PASSWORD: 'pass'
      };

      __mockSend
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      const resultPromise = executeRedis('_redis_get', env, 'key');

      for (let i = 0; i < 20; i++) {
        await advanceTimers(100);
      }

      await expect(resultPromise).rejects.toThrow('ECONNRESET');
      expect(__mockSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('executeRedisScan', () => {
    test('should scan keys properly', async () => {
      const env = {
        NF_REDIS_URL: 'rediss://example.com:6380',
        NF_REDIS_PASSWORD: 'pass'
      };
      
      __mockSend
        .mockResolvedValueOnce(['10', ['key1']])
        .mockResolvedValueOnce(['0', ['key2']]);

      const result = await executeRedisScan(env, 'prefix');
      
      expect(result.keys).toHaveLength(2);
      expect(result.keys[0].name).toBe('key1');
      expect(result.keys[1].name).toBe('key2');
    });

    test('should retry scan on network error', async () => {
      const env = {
        NF_REDIS_URL: 'rediss://example.com:6380',
        NF_REDIS_PASSWORD: 'pass'
      };

      __mockSend
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(['0', ['key1']]);

      const resultPromise = executeRedisScan(env, 'prefix');

      for (let i = 0; i < 10; i++) {
        await advanceTimers(100);
      }

      const result = await resultPromise;

      expect(result.keys).toHaveLength(1);
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkRedisHealth', () => {
    test('should use PING command', async () => {
      const env = {
        NF_REDIS_URL: 'rediss://example.com:6380',
        NF_REDIS_PASSWORD: 'pass'
      };

      __mockSend.mockResolvedValueOnce('PONG');

      const resultPromise = checkRedisHealth(env, {});

      for (let i = 0; i < 10; i++) {
        await advanceTimers(100);
      }

      const result = await resultPromise;

      expect(result).toBe(true);
      expect(__mockSend).toHaveBeenCalledWith('PING');
    });

    test('should retry PING on ECONNRESET and succeed', async () => {
      const env = {
        NF_REDIS_URL: 'rediss://example.com:6380',
        NF_REDIS_PASSWORD: 'pass'
      };

      __mockSend
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce('PONG');

      const resultPromise = checkRedisHealth(env, {});

      for (let i = 0; i < 20; i++) {
        await advanceTimers(100);
      }

      const result = await resultPromise;

      expect(result).toBe(true);
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });
  });
});
