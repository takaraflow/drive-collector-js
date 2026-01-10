import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CacheTLSClient } from '../src/cache/cache-tls-client.js';

describe('CacheTLSClient', () => {
  let client;

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
        if (buffer instanceof ArrayBuffer) {
          const uint8 = new Uint8Array(buffer);
          return String.fromCharCode.apply(null, uint8);
        }
        return String(buffer);
      })
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('_isStrictFalse', () => {
    test('should return true for false boolean', () => {
      expect(CacheTLSClient._isStrictFalse(false)).toBe(true);
    });

    test('should return false for true boolean', () => {
      expect(CacheTLSClient._isStrictFalse(true)).toBe(false);
    });

    test('should return true for "false" string', () => {
      expect(CacheTLSClient._isStrictFalse('false')).toBe(true);
      expect(CacheTLSClient._isStrictFalse('FALSE')).toBe(true);
      expect(CacheTLSClient._isStrictFalse('  false  ')).toBe(true);
    });

    test('should return true for "0" string', () => {
      expect(CacheTLSClient._isStrictFalse('0')).toBe(true);
    });

    test('should return true for "no" string', () => {
      expect(CacheTLSClient._isStrictFalse('no')).toBe(true);
      expect(CacheTLSClient._isStrictFalse('NO')).toBe(true);
      expect(CacheTLSClient._isStrictFalse('  no  ')).toBe(true);
    });

    test('should return false for other values', () => {
      expect(CacheTLSClient._isStrictFalse(true)).toBe(false);
      expect(CacheTLSClient._isStrictFalse('yes')).toBe(false);
      expect(CacheTLSClient._isStrictFalse('1')).toBe(false);
    });
  });

  describe('Constructor', () => {
    test('should create instance with url', () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      expect(client.url).toBe('redis://localhost:6379');
      expect(client.providerName).toBe('CacheTLS');
      expect(client.password).toBeUndefined();
    });

    test('should create instance with url and password', () => {
      const client = new CacheTLSClient('redis://localhost:6379', 'secret');
      expect(client.url).toBe('redis://localhost:6379');
      expect(client.password).toBe('secret');
    });

    test('should create instance with rediss:// url', () => {
      const client = new CacheTLSClient('rediss://localhost:6379');
      expect(client.tlsOptions.rejectUnauthorized).toBe(true);
      expect(client.tlsOptions.servername).toBe('localhost');
    });

    test('should set rejectUnauthorized to false for rediss://', () => {
      const client = new CacheTLSClient('rediss://localhost:6379', null, { rejectUnauthorized: false });
      expect(client.tlsOptions.rejectUnauthorized).toBe(false);
    });

    test('should set rejectUnauthorized to false for string "false"', () => {
      const client = new CacheTLSClient('rediss://localhost:6379', null, { rejectUnauthorized: 'false' });
      expect(client.tlsOptions.rejectUnauthorized).toBe(false);
    });

    test('should set rejectUnauthorized to true for string "true"', () => {
      const client = new CacheTLSClient('rediss://localhost:6379', null, { rejectUnauthorized: 'true' });
      expect(client.tlsOptions.rejectUnauthorized).toBe(true);
    });

    test('should set custom ca cert', () => {
      const caCert = '-----BEGIN CERTIFICATE-----...';
      const client = new CacheTLSClient('rediss://localhost:6379', null, { caCert });
      expect(client.tlsOptions.ca).toBe(caCert);
    });

    test('should set custom servername', () => {
      const client = new CacheTLSClient('rediss://localhost:6379', null, { sniServername: 'custom-host' });
      expect(client.tlsOptions.servername).toBe('custom-host');
    });

    test('should not set TLS options for redis:// url', () => {
      const client = new CacheTLSClient('redis://localhost:6379', null, { rejectUnauthorized: false });
      expect(Object.keys(client.tlsOptions)).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    test('should return early if not connected', async () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      await expect(client.disconnect()).resolves.not.toThrow();
    });

    test('should disconnect and clean up when connected', async () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      const mockClose = jest.fn().mockResolvedValue(undefined);
      client.client = { close: mockClose };

      await client.disconnect();
      expect(mockClose).toHaveBeenCalled();
      expect(client.client).toBeNull();
    });
  });

  describe('getProviderName', () => {
    test('should return provider name', () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      expect(client.getProviderName()).toBe('CacheTLS');
    });
  });

  describe('getConnectionInfo', () => {
    test('should return connection info when not connected', () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      const info = client.getConnectionInfo();
      expect(info).toEqual({
        provider: 'CacheTLS',
        connected: false,
        url: 'redis://localhost:6379',
        tls: false
      });
    });

    test('should return connection info when connected', () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      client.client = {};
      const info = client.getConnectionInfo();
      expect(info).toEqual({
        provider: 'CacheTLS',
        connected: true,
        url: 'redis://localhost:6379',
        tls: false
      });
    });

    test('should return connection info with TLS', () => {
      const client = new CacheTLSClient('rediss://localhost:6379');
      client.client = {};
      const info = client.getConnectionInfo();
      expect(info).toEqual({
        provider: 'CacheTLS',
        connected: true,
        url: 'rediss://localhost:6379',
        tls: true
      });
    });
  });

  describe('destroy', () => {
    test('should destroy client', async () => {
      const client = new CacheTLSClient('redis://localhost:6379');
      const mockClose = jest.fn().mockResolvedValue(undefined);
      client.client = { close: mockClose };

      await client.destroy();
      expect(mockClose).toHaveBeenCalled();
      expect(client.client).toBeNull();
    });
  });
});
