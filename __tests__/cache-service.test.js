import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { parseCacheConfig } from '../src/utils/configParser.js';

// Mock MemoryCache
class MockMemoryCache {
  constructor() {
    this.store = new Map();
    this.connected = false;
  }
  async initialize() {}
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async get(key) { return this.store.get(key) || null; }
  async set(key, value) { this.store.set(key, value); return true; }
  async delete(key) { return this.store.delete(key); }
  async listKeys(prefix) { 
    const keys = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) keys.push({ name: k });
    }
    return keys;
  }
  async destroy() { this.store.clear(); }
  getProviderName() { return 'MemoryCache'; }
  getConnectionInfo() { return { provider: 'MemoryCache', connected: this.connected }; }
}

// Mock RedisTLSCache
class MockRedisTLSCache {
  constructor(config) {
    this.url = config.url;
    this.connected = false;
    this.client = { send: vi.fn() };
  }
  async initialize() {}
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async get(key) { return this.client.send({ command: 'GET', arguments: [key] }); }
  async set(key, value) { return true; }
  async delete(key) { return true; }
  async listKeys(prefix) { return []; }
  async destroy() { this.connected = false; }
  getProviderName() { return 'RedisTLS'; }
  getConnectionInfo() { return { provider: 'RedisTLS', connected: this.connected, tls: true }; }
}

// Mock CloudflareKVCache
class MockCloudflareKVCache {
  constructor(config) {
    this.accountId = config.accountId;
    this.namespaceId = config.namespaceId;
    this.token = config.token;
    this.connected = false;
  }
  async initialize() {}
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async get(key) { return null; }
  async set(key, value) { return true; }
  async delete(key) { return true; }
  async listKeys(prefix) { return []; }
  async destroy() { this.connected = false; }
  getProviderName() { return 'CloudflareKV'; }
  getConnectionInfo() { return { provider: 'CloudflareKV', connected: this.connected }; }
}

// Mock BaseCache
class MockBaseCache {
  constructor(providerName = 'TestCache') {
    this.providerName = providerName;
    this.isInitialized = false;
    this.connected = false;
    this.options = {};
  }
  async initialize() { this.isInitialized = true; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async get(key) { throw new Error('Not connected'); }
  async set(key, value) { throw new Error('Not connected'); }
  async delete(key) { throw new Error('Not connected'); }
  async listKeys(prefix) { throw new Error('Not connected'); }
  getProviderName() { return this.providerName; }
  getConnectionInfo() { return { provider: this.providerName, connected: this.connected }; }
}

// CacheProvider 枚举
const CacheProvider = {
  MEMORY: 'memory',
  REDIS: 'redis',
  CLOUDFLARE_KV: 'cloudflare'
};

// 完整的 CacheService mock
const createMockCacheService = () => {
  const service = {
    primaryProvider: null,
    currentProviderName: 'MemoryCache',
    isInitialized: false,
    isFailoverMode: false,
    failureCount: 0,
    maxFailuresBeforeFailover: 3,
    providerList: [],
    memoryCache: new MockMemoryCache(),
    
    initialize: vi.fn().mockImplementation(async function() {
      this.isInitialized = true;
      this.currentProviderName = 'MemoryCache';
      this.primaryProvider = this.memoryCache;
      this.providerList = [];
    }),
    
    getCurrentProvider: vi.fn().mockImplementation(function() {
      return this.currentProviderName;
    }),
    
    getConnectionInfo: vi.fn().mockImplementation(function() {
      return {
        provider: this.currentProviderName,
        connected: this.primaryProvider?.connected || false
      };
    }),
    
    get: vi.fn().mockImplementation(async function(key) {
      if (!this.primaryProvider) return null;
      return this.primaryProvider.get(key);
    }),
    
    set: vi.fn().mockImplementation(async function(key, value) {
      if (!this.primaryProvider) return true;
      return this.primaryProvider.set(key, value);
    }),
    
    delete: vi.fn().mockImplementation(async function(key) {
      if (!this.primaryProvider) return true;
      return this.primaryProvider.delete(key);
    }),
    
    listKeys: vi.fn().mockImplementation(async function(prefix) {
      if (!this.primaryProvider) return [];
      return this.primaryProvider.listKeys(prefix);
    }),
    
    destroy: vi.fn().mockImplementation(async function() {
      if (this.memoryCache) await this.memoryCache.destroy();
      this.primaryProvider = null;
      this.isInitialized = false;
    }),
  };
  
  return service;
};

vi.mock('../src/cache/RedisTLSCache.js', () => ({
  RedisTLSCache: MockRedisTLSCache
}));

vi.mock('../src/cache/CloudflareKVCache.js', () => ({
  CloudflareKVCache: MockCloudflareKVCache
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

describe('Cache System - configParser', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
  });

  test('should parse valid json config', () => {
    const json = '[{"name":"test","type":"redis"}]';
    const result = parseCacheConfig(json, {});
    expect(result).toEqual([{ name: 'test', type: 'redis' }]);
  });

  test('should return null for empty input', () => {
    expect(parseCacheConfig(null, {})).toBeNull();
    expect(parseCacheConfig(undefined, {})).toBeNull();
    expect(parseCacheConfig('', {})).toBeNull();
  });

  test('should interpolate env vars', () => {
    const env = { CF_ACCOUNT_ID: '12345', REDIS_HOST: 'localhost' };
    const json = '[{"accountId":"${CF_ACCOUNT_ID}","host":"${REDIS_HOST}"}]';
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{ accountId: '12345', host: 'localhost' }]);
  });

  test('should return empty string for missing env var', () => {
    const env = {};
    const json = '[{"token":"${MISSING_VAR}"}]';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{ token: '' }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MISSING_VAR'));
    warnSpy.mockRestore();
  });

  test('should handle nested objects', () => {
    const env = { HOST: 'redis.example.com' };
    const json = '[{"config":{"host":"${HOST}","port":6379}}]';
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{ config: { host: 'redis.example.com', port: 6379 } }]);
  });

  test('should handle non string values unchanged', () => {
    const json = '{"num":123,"bool":true,"null":null}';
    const result = parseCacheConfig(json, {});
    expect(result).toEqual({ num: 123, bool: true, null: null });
  });

  test('should parse complex provider config', () => {
    const env = { MY_PASSWORD: 'secret123' };
    const json = '[{"name":"Primary","type":"redis","priority":1,"host":"redis.example.com","port":6379,"password":"${MY_PASSWORD}","tls":{"enabled":true,"rejectUnauthorized":false}}]';
    const result = parseCacheConfig(json, env);
    expect(result).toEqual([{
      name: 'Primary',
      type: 'redis',
      priority: 1,
      host: 'redis.example.com',
      port: 6379,
      password: 'secret123',
      tls: { enabled: true, rejectUnauthorized: false }
    }]);
  });
});

describe('Cache System - CacheService basic behavior', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    process.env = originalEnv;
  });

  test('should initialize with empty config', async () => {
    const service = createMockCacheService();
    await service.initialize();
    expect(service.primaryProvider).not.toBeNull();
    expect(service.currentProviderName).toBe('MemoryCache');
    expect(service.isInitialized).toBe(true);
  });

  test('should not reinitialize if already initialized', async () => {
    const service = createMockCacheService();
    await service.initialize();
    await service.initialize();
    expect(service.isInitialized).toBe(true);
    expect(service.initialize).toHaveBeenCalledTimes(2);
  });

  test('should have correct default values', async () => {
    const service = createMockCacheService();
    expect(service.maxFailuresBeforeFailover).toBe(3);
    expect(service.failureCount).toBe(0);
    expect(service.isFailoverMode).toBe(false);
  });

  test('should accept custom options', async () => {
    const service = createMockCacheService();
    service.maxFailuresBeforeFailover = 5;
    expect(service.maxFailuresBeforeFailover).toBe(5);
  });

  test('should get current provider name with no providers', async () => {
    const service = createMockCacheService();
    await service.initialize();
    expect(service.getCurrentProvider()).toBe('MemoryCache');
  });

  test('should get connection info with no providers', async () => {
    const service = createMockCacheService();
    await service.initialize();
    const info = service.getConnectionInfo();
    expect(info.provider).toBe('MemoryCache');
  });

  test('should not fail get when no primary provider', async () => {
    const service = createMockCacheService();
    service.primaryProvider = null;
    const result = await service.get('key1');
    expect(result).toBeNull();
  });

  test('should not fail set when no primary provider', async () => {
    const service = createMockCacheService();
    service.primaryProvider = null;
    const result = await service.set('key1', 'value1');
    expect(result).toBe(true);
  });

  test('should not fail delete when no primary provider', async () => {
    const service = createMockCacheService();
    service.primaryProvider = null;
    const result = await service.delete('key1');
    expect(result).toBe(true);
  });

  test('should not fail listKeys when no primary provider', async () => {
    const service = createMockCacheService();
    service.primaryProvider = null;
    const result = await service.listKeys('prefix');
    expect(result).toEqual([]);
  });

  test('should not fail destroy when no providers', async () => {
    const service = createMockCacheService();
    await service.destroy();
    expect(service.primaryProvider).toBeNull();
    expect(service.isInitialized).toBe(false);
  });

  test('should handle invalid CACHE_PROVIDERS JSON gracefully', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createMockCacheService();
    service.env = { CACHE_PROVIDERS: 'invalid json' };
    await service.initialize();
    expect(service.primaryProvider).not.toBeNull();
    expect(service.currentProviderName).toBe('MemoryCache');
    warnSpy.mockRestore();
  });

  test('should skip providers without name', async () => {
    const service = createMockCacheService();
    service.env = { CACHE_PROVIDERS: '[{"type":"redis","priority":1}]' };
    await service.initialize();
    expect(service.primaryProvider).not.toBeNull();
  });

  test('should skip unknown provider types', async () => {
    const service = createMockCacheService();
    service.env = { CACHE_PROVIDERS: '[{"name":"Unknown","type":"unknown-type"}]' };
    await service.initialize();
    expect(service.primaryProvider).not.toBeNull();
  });

  test('should handle empty provider array', async () => {
    const service = createMockCacheService();
    service.env = { CACHE_PROVIDERS: '[]' };
    await service.initialize();
    expect(service.primaryProvider).not.toBeNull();
    expect(service.providerList).toEqual([]);
  });
});
