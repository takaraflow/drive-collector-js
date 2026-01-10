import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { RedisTLSCache } from '../src/cache/RedisTLSCache.js';

describe('RedisTLSCache', () => {
  let cache;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.123);

    // Mock TextDecoder
    global.TextDecoder = jest.fn().mockImplementation(() => ({
      decode: jest.fn((buffer) => {
        if (buffer instanceof Uint8Array) {
          return String.fromCharCode.apply(null, buffer);
        }
        return String(buffer);
      })
    }));

    // Mock TextEncoder
    global.TextEncoder = jest.fn().mockImplementation(() => ({
      encode: jest.fn((str) => new Uint8Array(str.split('').map(c => c.charCodeAt(0))))
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('Constructor', () => {
    test('should throw error when url is missing', () => {
      expect(() => new RedisTLSCache({})).toThrow('RedisTLSCache requires url option');
    });

    test('should create instance with url only', () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      expect(cache.url).toBe('redis://localhost:6379');
      expect(cache.password).toBeUndefined();
      expect(cache.providerName).toBe('RedisTLS');
    });

    test('should create instance with url and password', () => {
      const cache = new RedisTLSCache({
        url: 'redis://localhost:6379',
        password: 'secret'
      });
      expect(cache.url).toBe('redis://localhost:6379');
      expect(cache.password).toBe('secret');
    });

    test('should set TLS options for rediss:// url', () => {
      const cache = new RedisTLSCache({
        url: 'rediss://localhost:6379'
      });
      expect(cache.tlsOptions.rejectUnauthorized).toBe(true);
      expect(cache.tlsOptions.servername).toBe('localhost');
    });

    test('should set rejectUnauthorized to false when specified', () => {
      const cache = new RedisTLSCache({
        url: 'redis://localhost:6379',
        rejectUnauthorized: false
      });
      expect(cache.tlsOptions.rejectUnauthorized).toBe(false);
    });

    test('should set custom servername', () => {
      const cache = new RedisTLSCache({
        url: 'redis://localhost:6379',
        servername: 'custom-host'
      });
      expect(cache.tlsOptions.servername).toBe('custom-host');
    });
  });

  describe('disconnect', () => {
    test('should return early if not connected', async () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      await expect(cache.disconnect()).resolves.not.toThrow();
    });

    test('should disconnect and clean up when connected', async () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      const mockClose = jest.fn().mockResolvedValue(undefined);
      cache.client = { close: mockClose };

      await cache.disconnect();
      expect(mockClose).toHaveBeenCalled();
      expect(cache.client).toBeNull();
    });
  });

  describe('_decode', () => {
    beforeEach(() => {
      cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
    });

    test('should return null for null value', () => {
      expect(cache._decode(null)).toBeNull();
    });

    test('should return undefined for undefined value', () => {
      expect(cache._decode(undefined)).toBeUndefined();
    });

    test('should decode Uint8Array to string', () => {
      const uint8Array = new Uint8Array([116, 101, 115, 116]);
      expect(cache._decode(uint8Array)).toBe('test');
    });

    test('should decode ArrayBuffer to string', () => {
      const arrayBuffer = new ArrayBuffer(4);
      const uint8View = new Uint8Array(arrayBuffer);
      uint8View[0] = 116;
      uint8View[1] = 101;
      uint8View[2] = 115;
      uint8View[3] = 116;
      expect(cache._decode(arrayBuffer)).toBe('test');
    });

    test('should convert string to trimmed string', () => {
      expect(cache._decode('  test  ')).toBe('test');
    });
  });

  describe('getProviderName', () => {
    test('should return provider name', () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      expect(cache.getProviderName()).toBe('RedisTLS');
    });
  });

  describe('getConnectionInfo', () => {
    test('should return connection info when not connected', () => {
      const cache = new RedisTLSCache({
        url: 'redis://localhost:6379',
        rejectUnauthorized: false
      });
      const info = cache.getConnectionInfo();
      expect(info).toEqual({
        provider: 'RedisTLS',
        connected: false,
        tls: true
      });
    });

    test('should return connection info when connected', () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      cache.client = {};
      const info = cache.getConnectionInfo();
      expect(info).toEqual({
        provider: 'RedisTLS',
        connected: true,
        tls: false
      });
    });
  });

  describe('validateTLS', () => {
    test('should return false when no TLS options', () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      expect(cache.validateTLS()).toBe(false);
    });

    test('should return true when TLS options exist', () => {
      const cache = new RedisTLSCache({
        url: 'rediss://localhost:6379'
      });
      expect(cache.validateTLS()).toBe(true);
    });
  });

  describe('destroy', () => {
    test('should disconnect and destroy', async () => {
      const cache = new RedisTLSCache({ url: 'redis://localhost:6379' });
      const mockClose = jest.fn().mockResolvedValue(undefined);
      cache.client = { close: mockClose };

      await cache.destroy();
      expect(mockClose).toHaveBeenCalled();
      expect(cache.client).toBeNull();
    });
  });
});
