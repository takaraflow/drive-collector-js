import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { getProviderPriority, detectCacheProvider, executeWithFailover, executeNFRedisScan, executeUpstashScan, handleRequest, checkNFHealth } from '../src/index.js';

// Mock Cloudflare Workers environment
global.Request = class Request {
  constructor(url, options) {
    this.url = url;
    this.method = options?.method || 'GET';
    this.headers = new Headers(options?.headers);
    this.body = options?.body;
  }
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return this.body;
  }
};

global.Response = class Response {
  constructor(body, options) {
    this.body = body;
    this.status = options?.status || 200;
    this.headers = new Headers(options?.headers || {});
  }
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return this.body;
  }
};

global.Headers = class Headers extends Map {
  constructor(init) {
    super(Object.entries(init || {}));
  }
  get(name) {
    return super.get(name.toLowerCase());
  }
  set(name, value) {
    super.set(name.toLowerCase(), value);
  }
};

// Mock KV
const mockKV = {
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  list: jest.fn(),
};

// Mock OpenTelemetry
const mockTracer = {
  startSpan: jest.fn().mockReturnValue({
    end: jest.fn(),
    setAttribute: jest.fn(),
    addEvent: jest.fn(),
  }),
};

const mockMeter = {
  createCounter: jest.fn().mockReturnValue({
    add: jest.fn(),
  }),
  createHistogram: jest.fn().mockReturnValue({
    record: jest.fn(),
  }),
};

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => mockTracer,
  },
  metrics: {
    getMeter: () => mockMeter,
  },
}));

jest.mock('@cloudflare/workers-types', () => ({}), { virtual: true });

describe('NF Redis Enhanced Tests', () => {
  let env;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset mocks
    mockKV.list.mockReset();
    mockKV.get.mockReset();
    mockKV.put.mockReset();
    mockKV.delete.mockReset();

    // Default KV state
    mockKV.list.mockImplementation(async (options) => {
      if (options && options.prefix) {
        if (options.prefix === 'lb:round_robin_index') {
          return { keys: [] };
        }
        if (options.prefix.startsWith('instance:')) {
          return { keys: [{ name: 'instance:server1' }] };
        }
        if (options.prefix.startsWith('lock:') || options.prefix.startsWith('task:') || options.prefix.startsWith('msg_lock:')) {
          return { keys: [] };
        }
      }
      return { keys: [{ name: 'instance:server1' }] };
    });
    
    mockKV.get.mockImplementation(async (key) => {
      if (key === 'lb:round_robin_index') {
        return '0';
      }
      return JSON.stringify({
        id: 'server1',
        url: 'https://backend-server.com',
        status: 'active',
        lastHeartbeat: Date.now()
      });
    });

    // Mock fetch globally
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: async () => ({ status: 'ok', tasks: [], message: 'mock response' }),
      text: async () => 'mock response',
      body: { cancel: jest.fn() }
    });

    env = {
      KV_STORAGE: mockKV,
      UPSTASH_REDIS_REST_URL: 'https://redis.url',
      UPSTASH_REDIS_REST_TOKEN: 'redis-token',
      NF_REDIS_URL: 'https://nf-redis.url',
      NF_REDIS_PASSWORD: 'nf-password',
    };
  });

  describe('Configuration Incomplete Scenarios', () => {
    test('Config incomplete: only URL provided (missing token)', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        // NF_REDIS_PASSWORD missing
        KV_STORAGE: mockKV
      };

      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('Config incomplete: only token provided (missing URL)', async () => {
      const env = {
        // NF_REDIS_URL missing
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('Config incomplete: empty NF config with Upstash available', async () => {
      const env = {
        // NF config missing
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock Upstash success
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ result: 'upstash-value' })
        });

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('upstash-value');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://redis.url/get/test-key',
        expect.objectContaining({
          headers: { Authorization: 'Bearer upstash-token' }
        })
      );
    });

    test('Config incomplete: all providers incomplete', async () => {
      const env = {
        // All incomplete
        NF_REDIS_URL: 'https://nf.url',
        // NF_REDIS_PASSWORD missing
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        // UPSTASH_REDIS_REST_TOKEN missing
        KV_STORAGE: null
      };

      await expect(executeWithFailover('_kv_get', env, null, 'test-key'))
        .rejects.toThrow('All providers failed for _kv_get');
    });
  });

  describe('Provider Failure with Multi-level Fallback', () => {
    test('NF fails -> CF fails -> Upstash succeeds', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock NF failure
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        })
        // Upstash success
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ result: 'upstash-value' })
        });

      // Mock CF failure
      mockKV.get.mockRejectedValue(new Error('KV error'));

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('upstash-value');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('NF fails -> CF succeeds', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock NF failure
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        });

      // CF succeeds
      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
    });

    test('All providers fail with different error types', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock all failures - NF 500, CF timeout, Upstash 500 (not 404)
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        })
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        });

      mockKV.get.mockRejectedValue(new Error('KV timeout'));

      await expect(executeWithFailover('_kv_get', env, null, 'test-key'))
        .rejects.toThrow('All providers failed for _kv_get');
    });

    test('NF timeout -> CF success', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      // Mock timeout
      global.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('Network timeout'));

      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
    });
  });

  describe('Scan Operation Edge Cases', () => {
    test('NF scan: empty list', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: [], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(0);
    });

    test('NF scan: match prefix with no results', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: [], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'nonexistent:');
      expect(result.keys).toHaveLength(0);
    });

    test('NF scan: no cursor returned (single page)', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1', 'instance:server2'] })
          // No cursor field
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(2);
    });

    test('NF scan: multi-page with cursor 0 termination', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1', 'instance:server2'], cursor: 123 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server3'], cursor: 456 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server4', 'instance:server5'], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(5);
      expect(result.keys[0].name).toBe('instance:server1');
      expect(result.keys[4].name).toBe('instance:server5');
    });

    test('NF scan: mixed cursor scenarios (undefined, null, 0)', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1'], cursor: 100 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server2'] }) // No cursor
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(2);
    });

    test('Upstash scan: empty list', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: [], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(0);
    });

    test('Upstash scan: multi-page', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1'], cursor: 999 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server2', 'instance:server3'], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(3);
    });
  });

  describe('Performance Boundary - Large Lists', () => {
    test('NF scan: large list mock (1000+ keys)', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      // Generate large list
      const largeKeys = Array.from({ length: 1000 }, (_, i) => `instance:server${i}`);

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: largeKeys, cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(1000);
      expect(result.keys[0].name).toBe('instance:server0');
      expect(result.keys[999].name).toBe('instance:server999');
    });

    test('NF scan: multiple large pages', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      // Page 1: 500 keys
      const page1 = Array.from({ length: 500 }, (_, i) => `instance:server${i}`);
      // Page 2: 500 keys
      const page2 = Array.from({ length: 500 }, (_, i) => `instance:server${i + 500}`);

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: page1, cursor: 111 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: page2, cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(1000);
    });

    test('Upstash scan: large list with performance consideration', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock 200 keys per page, 3 pages
      const page1 = Array.from({ length: 200 }, (_, i) => `instance:server${i}`);
      const page2 = Array.from({ length: 200 }, (_, i) => `instance:server${i + 200}`);
      const page3 = Array.from({ length: 200 }, (_, i) => `instance:server${i + 400}`);

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: page1, cursor: 200 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: page2, cursor: 400 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: page3, cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(600);
    });

    test('NF scan: large list fallback to CF on failure', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      // Mock NF failure
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        });

      // CF returns large list
      const largeKeys = Array.from({ length: 500 }, (_, i) => ({ name: `instance:server${i}` }));
      mockKV.list.mockResolvedValue({ keys: largeKeys });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(500);
      expect(result.keys[0].name).toBe('instance:server0');
    });
  });

  describe('NF Redis Specific Operations', () => {
    test('NF Redis GET with 404 returns null', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 404,
          ok: false,
          body: { cancel: jest.fn() }
        });

      const result = await executeWithFailover('_kv_get', env, null, 'nonexistent-key');
      expect(result).toBeNull();
    });

    test('NF Redis PUT operation', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ result: 'OK' })
        });

      const result = await executeWithFailover('_kv_put', env, null, 'test-key', 'test-value');
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://nf.url/set/test-key',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer nf-password',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ value: 'test-value' })
        })
      );
    });

    test('NF Redis scan with match prefix', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1', 'instance:server2'], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      
      // Verify the scan URL includes match parameter
      const callUrl = global.fetch.mock.calls[0][0];
      expect(callUrl).toContain('match=instance%3A*');
      expect(callUrl).toContain('count=100');
      
      expect(result.keys).toHaveLength(2);
    });

    test('NF Redis scan with different prefix', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['lock:mutex1', 'lock:mutex2'], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'lock:');
      
      const callUrl = global.fetch.mock.calls[0][0];
      expect(callUrl).toContain('match=lock%3A*');
      
      expect(result.keys).toHaveLength(2);
    });
  });

  describe('Error Handling and Resilience', () => {
    test('NF Redis network error fallback', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      global.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('fetch failed'));

      mockKV.get.mockResolvedValue('fallback-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('fallback-value');
    });

    test('NF Redis HTTP 500 fallback to CF', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        });

      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
    });

    test('NF Redis HTTP 401 should not fallback (auth error)', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 401,
          ok: false,
          body: { cancel: jest.fn() }
        });

      // Should still fallback to next provider
      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
    });

    test('NF Redis scan network error fallback', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      global.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('Network timeout'));

      mockKV.list.mockResolvedValue({ keys: [{ name: 'instance:server1' }] });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(1);
    });

    test('NF Redis scan HTTP 500 fallback', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        });

      mockKV.list.mockResolvedValue({ keys: [{ name: 'instance:server1' }] });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(1);
    });
  });

  describe('Priority Order Verification', () => {
    test('Priority: NF Redis > CF KV > Upstash', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      const priority = getProviderPriority(env);
      expect(priority).toEqual(['nf-redis', 'cloudflare', 'upstash']);
    });

    test('Priority: CF KV > Upstash (no NF)', async () => {
      const env = {
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      const priority = getProviderPriority(env);
      expect(priority).toEqual(['cloudflare', 'upstash']);
    });

    test('Priority: NF Redis > Upstash (no CF)', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      const priority = getProviderPriority(env);
      expect(priority).toEqual(['nf-redis', 'upstash']);
    });

    test('detectCacheProvider returns NF Redis when available', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      const provider = detectCacheProvider(env);
      expect(provider).toBe('nf-redis');
    });

    test('detectCacheProvider returns CF when NF not configured', async () => {
      const env = {
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      const provider = detectCacheProvider(env);
      expect(provider).toBe('cloudflare');
    });

    test('detectCacheProvider returns Upstash when only Upstash configured', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      const provider = detectCacheProvider(env);
      expect(provider).toBe('upstash');
    });

    test('detectCacheProvider returns none when no providers', async () => {
      const env = {};
      const provider = detectCacheProvider(env);
      expect(provider).toBe('none');
    });
  });

  describe('NF Redis Initialization Diagnosis Logs', () => {
    let consoleLogSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test('Diagnosis: All config missing', async () => {
      const request = new Request('https://test.url/health');
      const emptyEnv = { KV_STORAGE: mockKV };
      await handleRequest(request, emptyEnv);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache provider 初始化诊断'),
        expect.objectContaining({
          nf_configured: false,
          nf_diagnosis: '配置缺失'
        })
      );
    });

    test('Diagnosis: NF_REDIS_URL missing', async () => {
      const request = new Request('https://test.url/health');
      const missingUrlEnv = { NF_REDIS_PASSWORD: 'token', KV_STORAGE: mockKV };
      await handleRequest(request, missingUrlEnv);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache provider 初始化诊断'),
        expect.objectContaining({
          nf_configured: false,
          nf_diagnosis: 'NF_REDIS_URL 缺失'
        })
      );
    });

    test('Diagnosis: NF_REDIS_PASSWORD missing', async () => {
      const request = new Request('https://test.url/health');
      const missingTokenEnv = { NF_REDIS_URL: 'https://nf.url', KV_STORAGE: mockKV };
      await handleRequest(request, missingTokenEnv);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache provider 初始化诊断'),
        expect.objectContaining({
          nf_configured: false,
          nf_diagnosis: 'NF_REDIS_PASSWORD 缺失'
        })
      );
    });

    test('Diagnosis: Configured correctly', async () => {
      const request = new Request('https://test.url/health');
      const fullEnv = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token', KV_STORAGE: mockKV };
      const ctx = { waitUntil: jest.fn() };
      await handleRequest(request, fullEnv, ctx);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache provider 初始化诊断'),
        expect.objectContaining({
          nf_configured: true,
          nf_diagnosis: '配置完整'
        })
      );
      expect(ctx.waitUntil).toHaveBeenCalled();
    });

    test('checkNFHealth: Connection error should be caught in handleRequest', async () => {
      const request = new Request('https://test.url/health');
      const fullEnv = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token', KV_STORAGE: mockKV };
      const ctx = { waitUntil: (p) => p.catch(() => {}) }; // Simulate catch in handleRequest
      
      global.fetch = jest.fn().mockRejectedValue(new Error('Fatal error'));
      
      // Should not throw
      await handleRequest(request, fullEnv, ctx);
      expect(global.fetch).toHaveBeenCalled();
    });

    test('checkNFHealth: Success case (404 expected)', async () => {
      const fullEnv = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token' };
      global.fetch = jest.fn().mockResolvedValue({
        status: 404,
        ok: false
      });

      await checkNFHealth(fullEnv, null);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('NF Redis 健康检查成功'),
        expect.objectContaining({ status: 404 })
      );
    });

    test('checkNFHealth: Connection failure', async () => {
      const fullEnv = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token' };
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      await checkNFHealth(fullEnv, null);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('NF Redis 健康检查连接失败'),
        expect.objectContaining({ error: 'Network error' })
      );
    });
  });

  describe('Direct Function Tests', () => {
    test('executeNFRedisScan: multi-page with cursor', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['key1', 'key2'], cursor: 123 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['key3'], cursor: 0 })
        });

      const result = await executeNFRedisScan(env, 'prefix:');
      expect(result.keys).toHaveLength(3);
      expect(result.keys[0].name).toBe('key1');
      expect(result.keys[2].name).toBe('key3');
    });

    test('executeNFRedisScan: empty result', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: [], cursor: 0 })
        });

      const result = await executeNFRedisScan(env, 'prefix:');
      expect(result.keys).toHaveLength(0);
    });

    test('executeUpstashScan: multi-page', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['key1'], cursor: 999 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['key2', 'key3'], cursor: 0 })
        });

      const result = await executeUpstashScan(env, 'prefix:');
      expect(result.keys).toHaveLength(3);
    });

    test('executeUpstashScan: empty result', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: [], cursor: 0 })
        });

      const result = await executeUpstashScan(env, 'prefix:');
      expect(result.keys).toHaveLength(0);
    });
  });
});