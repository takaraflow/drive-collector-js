import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CloudflareKVCache } from '../src/cache/CloudflareKVCache.js';

describe('CloudflareKVCache', () => {
  let mockFetch;
  let mockAbortController;
  let mockAbortSignal;
  let clearTimeoutSpy;
  let cache;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.123);

    mockAbortSignal = {};
    mockAbortController = {
      signal: mockAbortSignal,
      abort: jest.fn()
    };

    global.AbortController = jest.fn().mockImplementation(() => mockAbortController);

    clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('Constructor', () => {
    test('should throw error when accountId is missing', () => {
      expect(() => new CloudflareKVCache({
        namespaceId: 'ns-id',
        token: 'token'
      })).toThrow('CloudflareKVCache requires accountId, namespaceId, and token');
    });

    test('should throw error when namespaceId is missing', () => {
      expect(() => new CloudflareKVCache({
        accountId: 'account-id',
        token: 'token'
      })).toThrow('CloudflareKVCache requires accountId, namespaceId, and token');
    });

    test('should throw error when token is missing', () => {
      expect(() => new CloudflareKVCache({
        accountId: 'account-id',
        namespaceId: 'ns-id'
      })).toThrow('CloudflareKVCache requires accountId, namespaceId, and token');
    });

    test('should create instance with valid config', () => {
      const cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      expect(cache).toBeInstanceOf(CloudflareKVCache);
      expect(cache.accountId).toBe('test-account');
      expect(cache.namespaceId).toBe('test-namespace');
      expect(cache.token).toBe('test-token');
      expect(cache.connected).toBe(false);
      expect(cache.apiUrl).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-namespace');
    });
  });

  describe('connect/disconnect', () => {
    test('should set connected to true after connect', async () => {
      const cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      await cache.connect();
      expect(cache.connected).toBe(true);
    });

    test('should set connected to false after disconnect', async () => {
      const cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      cache.connected = true;
      await cache.disconnect();
      expect(cache.connected).toBe(false);
    });
  });

  describe('get', () => {
    beforeEach(() => {
      cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      cache.connected = true;
    });

    test('should return null for 404 status', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 404,
        ok: false
      });

      const result = await cache.get('nonexistent-key', 'json');
      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-namespace/values/nonexistent-key',
        {
          headers: { 'Authorization': 'Bearer test-token' },
          signal: mockAbortSignal
        }
      );
    });

    test('should return null for non-ok status', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        ok: false
      });

      const result = await cache.get('error-key', 'json');
      expect(result).toBeNull();
    });

    test('should return json value for ok status', async () => {
      const jsonData = { test: 'data' };
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => jsonData
      });

      const result = await cache.get('test-key', 'json');
      expect(result).toEqual(jsonData);
    });

    test('should return text value for text type', async () => {
      const textData = 'plain text';
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => textData
      });

      const result = await cache.get('test-key', 'text');
      expect(result).toBe(textData);
    });

    test('should return arrayBuffer value for arrayBuffer type', async () => {
      const bufferData = new Uint8Array([1, 2, 3]);
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        arrayBuffer: async () => bufferData.buffer
      });

      const result = await cache.get('test-key', 'arrayBuffer');
      expect(result).toBeInstanceOf(ArrayBuffer);
    });

    test('should return null on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.get('error-key', 'json');
      expect(result).toBeNull();
    });

    test('should handle fetch error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.get('error-key', 'json');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    beforeEach(() => {
      cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      cache.connected = true;
    });

    test('should set value with default ttl', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true
      });

      const result = await cache.set('test-key', 'test-value');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('test-key'),
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json'
          },
          body: 'test-value'
        })
      );
    });

    test('should set json value', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true
      });

      const result = await cache.set('test-key', { nested: 'value' });
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ nested: 'value' })
        })
      );
    });

    test('should set value with custom ttl', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true
      });

      const result = await cache.set('test-key', 'test-value', 7200);
      expect(result).toBe(true);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('expiration_ttl')).toBe('7200');
    });

    test('should force ttl to minimum 60 seconds', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true
      });

      const result = await cache.set('test-key', 'test-value', 30);
      expect(result).toBe(true);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('expiration_ttl')).toBe('60');
    });

    test('should return false on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false
      });

      const result = await cache.set('test-key', 'test-value');
      expect(result).toBe(false);
    });

    test('should return false on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.set('test-key', 'test-value');
      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      cache.connected = true;
    });

    test('should delete key successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true
      });

      const result = await cache.delete('test-key');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-namespace/values/test-key',
        {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer test-token' },
          signal: mockAbortSignal
        }
      );
    });

    test('should return false on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.delete('test-key');
      expect(result).toBe(false);
    });
  });

  describe('exists', () => {
    beforeEach(() => {
      cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      cache.connected = true;
    });

    test('should return true for existing key', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true
      });

      const result = await cache.exists('test-key');
      expect(result).toBe(true);
    });

    test('should return false for non-existing key (404)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 404,
        ok: false
      });

      const result = await cache.exists('nonexistent-key');
      expect(result).toBe(false);
    });

    test('should return false on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.exists('test-key');
      expect(result).toBe(false);
    });
  });

  describe('listKeys', () => {
    beforeEach(() => {
      cache = new CloudflareKVCache({
        accountId: 'test-account',
        namespaceId: 'test-namespace',
        token: 'test-token'
      });
      cache.connected = true;
    });

    test('should list keys with prefix', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [
            { name: 'prefix:key1' },
            { name: 'prefix:key2' }
          ]
        })
      });

      const result = await cache.listKeys('prefix');
      expect(result).toEqual(['prefix:key1', 'prefix:key2']);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/test-namespace/keys?prefix=prefix',
        {
          headers: { 'Authorization': 'Bearer test-token' },
          signal: mockAbortSignal
        }
      );
    });

    test('should handle empty result', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: [] })
      });

      const result = await cache.listKeys('prefix');
      expect(result).toEqual([]);
    });

    test('should return empty array on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await cache.listKeys('prefix');
      expect(result).toEqual([]);
    });
  });
});
