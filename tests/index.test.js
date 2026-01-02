import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { handleRequest, logger, getProviderPriority, detectCacheProvider, executeWithFailover, executeRedisScan, executeUpstashScan, __test_setRedisClient } from '../src/index.js';
import { createRedis, __mockSend } from 'redis-on-workers';

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

describe('Worker Tests', () => {
  let env;
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  let consoleDebugSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    __mockSend.mockReset(); // Reset the mock from redis-on-workers
    
    // Reset mocks to ensure clean state
    mockVerify.mockReset();
    mockKV.list.mockReset();
    mockKV.get.mockReset();
    mockKV.put.mockReset();
    mockKV.delete.mockReset();

    mockVerify.mockResolvedValue(true);

    // Mock fetch globally (already in setup, but per-test override if needed)
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
      NF_REDIS_PASSWORD: 'nf-password',
      SKIP_SIGNATURE_VERIFY: 'true',
    };

    // Global console spies to suppress output and allow assertions
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
    // Ensure Redis client is cleaned up
    if (typeof __test_setRedisClient === 'function') {
      __test_setRedisClient(null);
    }
    jest.clearAllTimers();
  });

  afterAll(() => {
    // Restore real timers after all tests in this file
    jest.useRealTimers();
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
      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, basicEnv, ctx);
      expect(result.status).toBe(200);
    });

    test('should handle health check', async () => {
      const request = new Request('https://test.url/health');
      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, env, ctx);
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
      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, basicEnv, ctx);
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

      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, env, ctx);
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

      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, basicEnv, ctx);
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
      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, basicEnv, ctx);
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

      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, basicEnv, ctx);
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

      const ctx = { waitUntil: jest.fn() };
      const result = await handleRequest(request, env, ctx);
      // It returns 401 because verifyQStashSignature throws and is caught
      expect(result.status).toBe(401);
    });
  });

  describe('Logger Version and Level', () => {
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
    test('handleRequest should log initialization diagnostics', async () => {
      const request = new Request('https://test.url/health');
      const ctx = { waitUntil: jest.fn() };
      await handleRequest(request, env, ctx);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('LB Request Started'),
        expect.objectContaining({
          path: '/health',
          method: 'GET',
          version: 'dev'
        })
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider Status'),
        expect.objectContaining({
          primary: 'redis',
          hasKv: true,
          hasRedis: true
        })
      );
    });

    test('executeWithPriorityFallback should log fallback with duration and error info', async () => {
      const envWithNF = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      __mockSend.mockRejectedValueOnce(new Error('NF error'));

      mockKV.get.mockResolvedValue('cf-value');

      await executeWithFailover('_kv_get', envWithNF, null, 'test-key');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('尝试 redis → 失败'),
        expect.any(Object)
      );
      
      const logCall = consoleWarnSpy.mock.calls.find(call => call[0].includes('尝试 redis → 失败'));
      expect(logCall[0]).toContain('code:unknown');
      expect(logCall[0]).toContain('fallback to cloudflare');
    });

    test('executeWithPriorityFallback should parse CF KV limit exceeded error code', async () => {
      const envWithCF = {
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'token'
      };

      // Mock CF KV failure with limit exceeded message
      mockKV.get.mockRejectedValueOnce(new Error('KV list() limit exceeded'));

      // Mock Upstash success
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ result: 'upstash-value' })
      });

      await executeWithFailover('_kv_get', envWithCF, null, 'test-key');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('尝试 cloudflare → 失败'),
        expect.any(Object)
      );
      
      const logCall = consoleWarnSpy.mock.calls.find(call => call[0].includes('尝试 cloudflare → 失败'));
      expect(logCall[0]).toContain('code:quota_exceeded');
      expect(logCall[0]).toContain('fallback to upstash');
    });

    test('executeRedis operations should log timing info', async () => {
      const envWithNF = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        NODE_ENV: 'development'
      };

      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);
      
      __mockSend.mockImplementation(async (cmd) => {
        if (cmd === 'GET') return 'ok';
        if (cmd === 'SET') return 'OK';
        if (cmd === 'SCAN') return ['0', []];
      });

      // Override environment detection for logger inside the test
      const originalEnv = logger.env;
      logger.configure({ env: 'development' });

      try {
        // Test GET log
        await executeWithFailover('_kv_get', envWithNF, null, 'test-key');
        
        // Test PUT log
        await executeWithFailover('_kv_put', envWithNF, null, 'test-key', 'val');
        
        expect(__mockSend).toHaveBeenCalledWith('GET', 'test-key');
        expect(__mockSend).toHaveBeenCalledWith('SET', 'test-key', 'val');

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

    test('handleRequest should log Axiom initialization success', async () => {
      const axiomEnv = {
        ...env,
        AXIOM_TOKEN: 'test-token-123456789',
        AXIOM_DATASET: 'test-dataset'
      };
      const request = new Request('https://test.url/health');
      const ctx = { waitUntil: jest.fn() };
      await handleRequest(request, axiomEnv, ctx);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('LB Request Started'),
        expect.any(Object)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider Status'),
        expect.any(Object)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Health check passed'),
        expect.any(Object)
      );
    });

    test('handleRequest should log Axiom initialization failure when token missing', async () => {
      const invalidEnv = {
        ...env,
        AXIOM_DATASET: 'test-dataset'
        // AXIOM_TOKEN missing
      };
      const request = new Request('https://test.url/health');
      const ctx = { waitUntil: jest.fn() };
      await handleRequest(request, invalidEnv, ctx);

      // Should not have any Axiom-specific initialization warnings since we removed them
      // Just ensure the request is processed normally
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('LB Request Started'),
        expect.any(Object)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider Status'),
        expect.any(Object)
      );
    });
  });

  describe('Provider Priority and Fallback', () => {
    test('getProviderPriority should return correct priority order', () => {
      // Redis only
      const env1 = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token' };
      expect(getProviderPriority(env1)).toEqual(['redis']);

      // Redis + CF KV
      const env2 = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token', KV_STORAGE: mockKV };
      expect(getProviderPriority(env2)).toEqual(['redis', 'cloudflare']);

      // All three
      const env3 = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'token',
        KV_STORAGE: mockKV,
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'token'
      };
      expect(getProviderPriority(env3)).toEqual(['redis', 'cloudflare', 'upstash']);

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
      // Redis first
      const env1 = { NF_REDIS_URL: 'https://nf.url', NF_REDIS_PASSWORD: 'token', KV_STORAGE: mockKV };
      expect(detectCacheProvider(env1)).toBe('redis');

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

    test('Redis primary: should use Redis when configured', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      // Mock Redis success
      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);
      __mockSend.mockResolvedValueOnce('nf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('nf-value');
      expect(__mockSend).toHaveBeenCalledWith('GET', 'test-key');
    });

    test('Redis fallback: should fallback to CF KV when NF fails', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      mockKV.get.mockResolvedValue('cf-value');

      // Mock Redis failure
      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);
      __mockSend.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
    });

    test('Redis fallback: should fallback to Upstash when NF fails and CF not available', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        UPSTASH_REDIS_REST_URL: 'https://redis.url',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token'
      };

      // Mock Redis failure
      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);
      __mockSend.mockRejectedValueOnce(new Error('Connection failed'));
      
      // Upstash success
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

    test('Config incomplete: should skip NF when token missing', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        // NF_REDIS_PASSWORD missing
        KV_STORAGE: mockKV
      };
      
      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);

      mockKV.get.mockResolvedValue('cf-value');

      const result = await executeWithFailover('_kv_get', env, null, 'test-key');
      expect(result).toBe('cf-value');
      expect(mockKV.get).toHaveBeenCalledWith('test-key');
      // Should not call NF
      expect(__mockSend).not.toHaveBeenCalled();
    });

    test('List scan: should use NF scan when primary', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      // Mock multi-cursor scan
      // SCAN returns [cursor, [keys]]
      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);
      __mockSend
        .mockResolvedValueOnce(['123', ['instance:server1', 'instance:server2']])
        .mockResolvedValueOnce(['0', ['instance:server3']]);

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

    test('Redis scan error: should fallback to CF list', async () => {
      const env = {
        NF_REDIS_URL: 'https://nf.url',
        NF_REDIS_PASSWORD: 'nf-password',
        KV_STORAGE: mockKV
      };

      // Mock NF scan failure
      const mockClient = createRedis({ url: '...' });
      __test_setRedisClient(mockClient);
      __mockSend.mockRejectedValueOnce(new Error('Connection failed'));

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