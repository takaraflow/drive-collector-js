import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { BaseCache } from '../src/cache/BaseCache.js';

describe('BaseCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.123);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Constructor', () => {
    test('should throw error when instantiated directly', () => {
      expect(() => new BaseCache()).toThrow('BaseCache is an abstract class and cannot be instantiated directly');
    });

    test('should allow subclass instantiation', () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      expect(testCache).toBeInstanceOf(BaseCache);
      expect(testCache.isInitialized).toBe(false);
      expect(testCache.connected).toBe(false);
      expect(testCache.options).toEqual({});
    });

    test('should accept options parameter', () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache({ test: 'value' });
      expect(testCache.options).toEqual({ test: 'value' });
    });

    test('should set provider name from constructor', () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      expect(testCache.providerName).toBe('TestCache');
    });
  });

  describe('initialize', () => {
    test('should set isInitialized to true', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await testCache.initialize();
      expect(testCache.isInitialized).toBe(true);
    });
  });

  describe('connect/disconnect', () => {
    test('should set connected to true after connect', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await testCache.connect();
      expect(testCache.connected).toBe(true);
    });

    test('should set connected to true without calling _connect', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await testCache.connect();
      expect(testCache.connected).toBe(true);
    });

    test('should call _connect if defined', async () => {
      class TestCache extends BaseCache {
        async _connect() {
          this.connected = true;
        }
      }
      const testCache = new TestCache();
      await testCache.connect();
      expect(testCache.connected).toBe(true);
    });

    test('should return early if already connected', async () => {
      class TestCache extends BaseCache {
        async _connect() {
          throw new Error('Should not be called');
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.connect()).resolves.not.toThrow();
    });

    test('should set connected to false after disconnect', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.disconnect();
      expect(testCache.connected).toBe(false);
    });

    test('should call _disconnect if defined', async () => {
      const disconnectSpy = vi.fn().mockResolvedValue(undefined);
      class TestCache extends BaseCache {
        async _disconnect() {
          disconnectSpy();
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.disconnect();
      expect(disconnectSpy).toHaveBeenCalled();
      expect(testCache.connected).toBe(false);
    });
  });

  describe('get', () => {
    test('should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.get('key')).rejects.toThrow('Not connected');
    });

    test('should throw error when _get not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.get('key')).rejects.toThrow('Not implemented');
    });

    test('should call _get when implemented', async () => {
      const getSpy = vi.fn().mockResolvedValue('value');
      class TestCache extends BaseCache {
        async _get(key, type) {
          getSpy(key, type);
          return 'value';
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      const result = await testCache.get('test-key', 'json');
      expect(result).toBe('value');
      expect(getSpy).toHaveBeenCalledWith('test-key', 'json');
    });

    test('should pass type parameter with default value', async () => {
      const getSpy = vi.fn().mockResolvedValue('value');
      class TestCache extends BaseCache {
        async _get(key, type) {
          getSpy(key, type);
          return 'value';
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.get('test-key');
      expect(getSpy).toHaveBeenCalledWith('test-key', 'json');
    });
  });

  describe('set', () => {
    test('should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.set('key', 'value')).rejects.toThrow('Not connected');
    });

    test('should throw error when _set not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.set('key', 'value')).rejects.toThrow('Not implemented');
    });

    test('should call _set with default ttl', async () => {
      const setSpy = vi.fn().mockResolvedValue(true);
      class TestCache extends BaseCache {
        async _set(key, value, ttl) {
          setSpy(key, value, ttl);
          return true;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.set('key', 'value');
      expect(setSpy).toHaveBeenCalledWith('key', 'value', 3600);
    });

    test('should call _set with custom ttl', async () => {
      const setSpy = vi.fn().mockResolvedValue(true);
      class TestCache extends BaseCache {
        async _set(key, value, ttl) {
          setSpy(key, value, ttl);
          return true;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.set('key', 'value', 7200);
      expect(setSpy).toHaveBeenCalledWith('key', 'value', 7200);
    });
  });

  describe('delete', () => {
    test('should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.delete('key')).rejects.toThrow('Not connected');
    });

    test('should throw error when _delete not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.delete('key')).rejects.toThrow('Not implemented');
    });

    test('should call _delete when implemented', async () => {
      const deleteSpy = vi.fn().mockResolvedValue(true);
      class TestCache extends BaseCache {
        async _delete(key) {
          deleteSpy(key);
          return true;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.delete('test-key');
      expect(deleteSpy).toHaveBeenCalledWith('test-key');
    });
  });

  describe('exists', () => {
    test('should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.exists('key')).rejects.toThrow('Not connected');
    });

    test('should throw error when _exists not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.exists('key')).rejects.toThrow('Not implemented');
    });

    test('should call _exists when implemented', async () => {
      class TestCache extends BaseCache {
        async _exists(key) {
          return true;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      const result = await testCache.exists('test-key');
      expect(result).toBe(true);
    });
  });

  describe('incr', () => {
    test('should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.incr('key')).rejects.toThrow('Not connected');
    });

    test('should throw error when _incr not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.incr('key')).rejects.toThrow('Not implemented');
    });

    test('should call _incr when implemented', async () => {
      class TestCache extends BaseCache {
        async _incr(key) {
          return 1;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      const result = await testCache.incr('counter');
      expect(result).toBe(1);
    });
  });

  describe('lock/unlock', () => {
    test('lock should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.lock('key')).rejects.toThrow('Not connected');
    });

    test('lock should throw error when _lock not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.lock('key')).rejects.toThrow('Not implemented');
    });

    test('lock should call _lock with default ttl', async () => {
      const lockSpy = vi.fn().mockResolvedValue(true);
      class TestCache extends BaseCache {
        async _lock(key, ttl) {
          lockSpy(key, ttl);
          return true;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.lock('resource');
      expect(lockSpy).toHaveBeenCalledWith('resource', 60);
    });

    test('unlock should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.unlock('key')).rejects.toThrow('Not connected');
    });

    test('unlock should throw error when _unlock not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.unlock('key')).rejects.toThrow('Not implemented');
    });

    test('unlock should call _unlock when implemented', async () => {
      const unlockSpy = vi.fn().mockResolvedValue(true);
      class TestCache extends BaseCache {
        async _unlock(key) {
          unlockSpy(key);
          return true;
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      await testCache.unlock('resource');
      expect(unlockSpy).toHaveBeenCalledWith('resource');
    });
  });

  describe('listKeys', () => {
    test('should throw error when not connected', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.listKeys('prefix')).rejects.toThrow('Not connected');
    });

    test('should throw error when _listKeys not implemented', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      await expect(testCache.listKeys('prefix')).rejects.toThrow('Not implemented');
    });

    test('should call _listKeys with default limit', async () => {
      class TestCache extends BaseCache {
        async _listKeys(prefix, limit) {
          return { keys: [] };
        }
      }
      const testCache = new TestCache();
      testCache.connected = true;
      const result = await testCache.listKeys('prefix');
      expect(result).toEqual({ keys: [] });
    });
  });

  describe('getProviderName', () => {
    test('should return provider name from constructor', () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      expect(testCache.getProviderName()).toBe('TestCache');
    });
  });

  describe('getConnectionInfo', () => {
    test('should return provider name and connection status', () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      const info = testCache.getConnectionInfo();
      expect(info).toEqual({
        provider: 'TestCache',
        connected: false
      });
    });

    test('should return connected status as true when connected', () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      testCache.connected = true;
      const info = testCache.getConnectionInfo();
      expect(info).toEqual({
        provider: 'TestCache',
        connected: true
      });
    });
  });

  describe('destroy', () => {
    test('should be callable without throwing', async () => {
      class TestCache extends BaseCache {}
      const testCache = new TestCache();
      await expect(testCache.destroy()).resolves.not.toThrow();
    });
  });
});
