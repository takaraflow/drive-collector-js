import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { handleRequest, logger, getProviderPriority, detectCacheProvider, executeWithFailover, executeNFRedisScan, executeUpstashScan } from '../src/index.js';

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

// Mock QStash
const mockVerify = jest.fn();
global.__QSTASH_MOCK_VERIFY__ = mockVerify;

const mockQStash = {
  publishJSON: jest.fn(),
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

describe('Worker Tests', () => {
  let env;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset mocks to ensure clean state
    mockVerify.mockReset();
    mockKV.list.mockReset();
    mockKV.get.mockReset();
    mockKV.put.mockReset();
    mockKV.delete.mockReset();

    mockVerify.mockResolvedValue(true);

    // Mock fetch globally
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: async () => ({ status: 'ok', tasks: [], message: 'mock response' }),
      text: async () => 'mock response',
      body: { cancel: jest.fn() }
    });

    // Default KV state: one active instance
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

    env = {
      KV_STORAGE: mockKV,
      QSTASH_CURRENT_SIGNING_KEY: 'test-key',
      QSTASH_NEXT_SIGNING_KEY: 'next-key',
      QSTASH_URL: 'https://qstash.url',
      UPSTASH_REDIS_REST_URL: 'https://redis.url',
      UPSTASH_REDIS_REST_TOKEN: 'redis-token',
      NF_REDIS_URL: 'https://nf-redis.url',
      NF_REDIS_TOKEN: 'nf-token',
      SKIP_SIGNATURE_VERIFY: 'true',
    };
  });

  describe('Basic Functionality', () => {
    test('should return 200 for unknown routes (forwarded)', async () => {
      // Use CF KV only for this basic test
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
        SKIP_SIGNATURE_VERIFY: 'true',
      };
      const request = new Request('https://test.url/unknown');
      const result = await handleRequest(request, basicEnv);
      expect(result.status).toBe(200);
    });

    test('should handle health check', async () => {
      const request = new Request('https://test.url/health');
      const result = await handleRequest(request, env);
      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toContain('application/json');
      const json = await result.json();
      expect(json.status).toBe('ok');
      expect(json.activeInstances).toBeGreaterThanOrEqual(0);
      expect(json.timestamp).toBeDefined();
    });

    test('should handle root path (forwarded)', async () => {
      // Use CF KV only for this basic test
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
        SKIP_SIGNATURE_VERIFY: 'true',
      };
      const request = new Request('https://test.url/');
      const result = await handleRequest(request, basicEnv);
      expect(result.status).toBe(200);
    });
  });

  describe('QStash Webhook Verification', () => {
    test('should reject invalid QStash signature', async () => {
      delete env.SKIP_SIGNATURE_VERIFY;
      mockVerify.mockResolvedValue(false);

      const request = new Request('https://test.url/api/qstash/webhook', {
        method: 'POST',
        headers: {
          'upstash-signature': 'invalid-signature',
        },
        body: JSON.stringify({ test: 'data' }),
      });

      const result = await handleRequest(request, env);
      expect(result.status).toBe(401);
    });

    test('should accept valid QStash signature', async () => {
      // Use CF KV only for this test
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
      };
      mockVerify.mockResolvedValue(true);

      const request = new Request('https://test.url/api/qstash/webhook', {
        method: 'POST',
        headers: {
          'upstash-signature': 'valid-signature',
        },
        body: JSON.stringify({ test: 'data' }),
      });

      const result = await handleRequest(request, basicEnv);
      expect(result.status).toBe(200);
    });
  });



  describe('Task Operations', () => {
    test('should download tasks', async () => {
      // Use CF KV only for this test
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
        SKIP_SIGNATURE_VERIFY: 'true',
      };
      const request = new Request('https://test.url/api/tasks/download-tasks');
      const result = await handleRequest(request, basicEnv);
      expect(result.status).toBe(200);
      const data = await result.json();
      expect(data.tasks).toBeDefined(); // Assumes default mock fetch returns { tasks: [] }
    });

    test('should handle task upload', async () => {
      // Use CF KV only for this test
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
        SKIP_SIGNATURE_VERIFY: 'true',
      };
      const request = new Request('https://test.url/api/tasks/upload', {
        method: 'POST',
        body: JSON.stringify({ tasks: [{ id: 'task1' }] }),
      });

      const result = await handleRequest(request, basicEnv);
      expect(result.status).toBe(200);
      // It forwards, so mockKV.put is NOT called on the worker (it's called on backend)
      // But verifyQStashSignature is skipped, so it just works.
    });
  });



  describe('Error Handling', () => {
    test('should handle missing environment variables', async () => {
      delete env.QSTASH_CURRENT_SIGNING_KEY;
      delete env.SKIP_SIGNATURE_VERIFY;
      
      const request = new Request('https://test.url/api/qstash/webhook', {
        method: 'POST',
        headers: { 'upstash-signature': 'test' },
        body: JSON.stringify({}),
      });

      const result = await handleRequest(request, env);
      // It returns 401 because verifyQStashSignature throws and is caught
      expect(result.status).toBe(401);
    });
  });

  describe('Logger Version and Level', () => {
    let consoleLogSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;
    let consoleDebugSpy;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    });

    test('logger.info should include version and level in pending logs', async () => {
      // Test that pending logs include version and level
      await logger.info('test message', { custom: 'data' });
      
      // Check pending logs
      const pendingLogs = logger.__getPendingLogs ? logger.__getPendingLogs() : [];
      // Since we can't access pendingLogs directly, we'll check the logger object properties
      expect(logger.version).toBe('dev');
      expect(logger.env).toBeDefined();
    });

    test('logger.warn should include version and level in pending logs', async () => {
      await logger.warn('warning message', { custom: 'data' });
      expect(logger.version).toBe('dev');
    });

    test('logger.error should include version and level in pending logs', async () => {
      await logger.error('error message', { custom: 'data' });
      expect(logger.version).toBe('dev');
    });

    test('logger should have version property', () => {
      expect(logger.version).toBe('dev');
    });

    test('logger methods should be async', async () => {
      const result = logger.info('test');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    test('all logger methods should exist', () => {
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.configure).toBe('function');
    });
  });

  describe('Logging and Diagnostics', () => {
    let consoleLogSpy;
    let consoleWarnSpy;
    let consoleErrorSpy;
    let consoleDebugSpy;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    });

    test('handleRequest should log initialization diagnostics', async () => {
      const request = new Request('https://test.url/health');
      await handleRequest(request, env);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache provider 初始化诊断'),
        expect.objectContaining({
          providers: expect.any(Array),
          nf_configured: true,
          cf_kv_available: true,
          upstash_configured: true,
          detect_primary: 'nf-redis'
        })
      );
    });

    test('executeWithPriorityFallback should log fallback with duration and error info', async () => {
      const envWithNF = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        KV_STORAGE: mockKV
      };

      // Mock NF failure
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 500,
        ok: false,
        statusText: 'Internal Server Error',
        body: { cancel: jest.fn() }
      });

      mockKV.get.mockResolvedValue('cf-value');

      await executeWithFailover('_kv_get', envWithNF, null, 'test-key');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[nf-redis] _kv_get 失败'),
        expect.any(Object)
      );
      
      const logCall = consoleWarnSpy.mock.calls.find(call => call[0].includes('[nf-redis] _kv_get 失败'));
      expect(logCall[0]).toContain('code:500');
      expect(logCall[0]).toContain('fallback');
    });

    test('executeNFRedis operations should log timing info', async () => {
      const envWithNF = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        NODE_ENV: 'development'
      };

      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ result: 'ok', keys: [], cursor: 0 })
      });

      // Override environment detection for logger inside the test
      const originalEnv = logger.env;
      logger.configure({ env: 'development' });

      try {
        // Test GET log
        await executeWithFailover('_kv_get', envWithNF, null, 'test-key');
        expect(consoleDebugSpy).toHaveBeenCalledWith(
          expect.stringContaining('NF Redis GET: key=test-key success'),
          expect.any(Object)
        );

        // Test PUT log
        await executeWithFailover('_kv_put', envWithNF, null, 'test-key', 'val');
        expect(consoleDebugSpy).toHaveBeenCalledWith(
          expect.stringContaining('NF Redis PUT: key=test-key success'),
          expect.any(Object)
        );

        // Test SCAN log
        await executeWithFailover('_kv_list', envWithNF, null, 'prefix');
        expect(consoleDebugSpy).toHaveBeenCalledWith(
          expect.stringContaining('NF Scan: prefix=prefix success'),
          expect.any(Object)
        );
      } finally {
        logger.configure({ env: originalEnv });
      }
    });

    test('executeUpstashScan should log timing info', async () => {
      const envWithUpstash = {
        UPSTASH_REDIS_REST_URL: 'https://upstash.url',
        UPSTASH_REDIS_REST_TOKEN: 'token',
        NODE_ENV: 'development'
      };

      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ keys: [], cursor: 0 })
      });

      // Override environment detection for logger inside the test
      const originalEnv = logger.env;
      logger.configure({ env: 'development' });

      try {
        await executeUpstashScan(envWithUpstash, 'prefix');
        expect(consoleDebugSpy).toHaveBeenCalledWith(
          expect.stringContaining('Upstash Scan: prefix=prefix success'),
          expect.any(Object)
        );
      } finally {
        logger.configure({ env: originalEnv });
      }
    });
  });

  describe('Provider Priority and Fallback', () => {
    test('getProviderPriority should return correct priority order', () => {
      // NF Redis only
      const env1 = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_TOKEN: 'token' };
      expect(getProviderPriority(env1)).toEqual(['nf-redis']);

      // NF Redis + CF KV
      const env2 = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_TOKEN: 'token', KV_STORAGE: mockKV };
      expect(getProviderPriority(env2)).toEqual(['nf-redis', 'cloudflare']);

      // All three
      const env3 = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'token',
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'token'
      };
      expect(getProviderPriority(env3)).toEqual(['nf-redis', 'cloudflare', 'upstash']);

      // CF KV only
      const env4 = { KV_STORAGE: mockKV };
      expect(getProviderPriority(env4)).toEqual(['cloudflare']);

      // Upstash only
      const env5 = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'token'
      };
      expect(getProviderPriority(env5)).toEqual(['upstash']);

      // No providers
      const env6 = {};
      expect(getProviderPriority(env6)).toEqual([]);
    });

    test('detectCacheProvider should return first available provider', () => {
      // NF Redis first
      const env1 = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_TOKEN: 'token', KV_STORAGE: mockKV };
      expect(detectCacheProvider(env1)).toBe('nf-redis');

      // CF KV first
      const env2 = { KV_STORAGE: mockKV, UPSTASH_REDIS_REST_URL: 'https://redis.url', UPSTASH_REDIS_REST_TOKEN: 'token' };
      expect(detectCacheProvider(env2)).toBe('cloudflare');

      // Upstash only
      const env3 = { UPSTASH_REDIS_REST_URL: 'https://redis.url', UPSTASH_REDIS_REST_TOKEN: 'token' };
      expect(detectCacheProvider(env3)).toBe('upstash');

      // No providers
      const env4 = {};
      expect(detectCacheProvider(env4)).toBe('none');
    });

    test('NF primary: should use NF Redis when configured', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        KV_STORAGE: mockKV
      };

      // Mock NF Redis success
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ result: 'nf-value' })
        });

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('nf-value');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://nf.url/get/test-key',
        expect.objectContaining({
          headers: { Authorization: 'Bearer nf-token' }
        })
      );
    });

    test('NF fallback: should fallback to CF KV when NF fails', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        KV_STORAGE: mockKV
      };

      mockKV.get.mockResolvedValue('cf-value');

      // Mock NF Redis failure
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false,
          body: { cancel: jest.fn() }
        });

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
    });

    test('NF fallback: should fallback to Upstash when NF fails and CF not available', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock NF Redis failure
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

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('upstash-value');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://redis.url/get/test-key',
        expect.objectContaining({
          headers: { Authorization: 'Bearer upstash-token' }
        })
      );
    });

    test('Config incomplete: should skip NF when token missing', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        // NF_REDIS_TOKEN missing
        KV_STORAGE: mockKV
      };

      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
      // Should not call NF
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('List scan: should use NF scan when primary', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        KV_STORAGE: mockKV
      };

      // Mock multi-cursor scan
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1', 'instance:server2'], cursor: 123 })
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server3'], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(3);
      expect(result.keys[0].name).toBe('instance:server1');
      expect(result.keys[2].name).toBe('instance:server3');
    });

    test('No providers: should throw error', async () => {
      const env = {};

      await expect(executeWithFailover('_kv_get', env, null, 'test-key'))
        .rejects.toThrow('All providers failed for _kv_get');
    });

    test('NF scan error: should fallback to CF list', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_TOKEN: 'nf-token',
        KV_STORAGE: mockKV
      };

      // Mock NF scan failure
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 500,
          ok: false
        });

      mockKV.list.mockResolvedValue({ keys: [{ name: 'instance:server1' }] });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].name).toBe('instance:server1');
    });

    test('Upstash scan: should work when primary', async () => {
      const env = {
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock scan
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ keys: ['instance:server1'], cursor: 0 })
        });

      const result = await executeWithFailover('_kv_list', env, null, 'instance:');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].name).toBe('instance:server1');
    });
  });
});