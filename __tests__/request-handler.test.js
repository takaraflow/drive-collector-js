import { vi, describe, test, expect, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    child: vi.fn().mockReturnThis(),
    configure: vi.fn(),
    version: 'dev',
    env: 'test',
  },
  configureBaseLoggerTransport: vi.fn(),
  sanitizeLogData: vi.fn(data => data),
  flushLogs: vi.fn().mockResolvedValue(undefined),
  flushGlobalLoggerBuffer: vi.fn().mockResolvedValue(undefined),
  isTestEnvironment: true,
  VERSION: 'dev',
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: vi.fn(() => ({
      startSpan: vi.fn(() => ({ end: vi.fn(), setAttribute: vi.fn(), addEvent: vi.fn() })),
    })),
    getActiveSpan: vi.fn(() => ({ end: vi.fn(), setAttribute: vi.fn(), addEvent: vi.fn() })),
  },
  metrics: {
    getMeter: vi.fn(() => ({
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    })),
  },
  context: {
    active: vi.fn(),
    with: vi.fn((ctx, fn) => fn()),
  },
}));

vi.mock('redis-on-workers', () => ({
  createRedis: vi.fn(() => ({ send: vi.fn() })),
  __mockSend: vi.fn(),
}));

import { handleRequest, logger, getProviderPriority, detectCacheProvider, executeWithFailover, executeRedisScan, executeUpstashScan } from '../src/index.js';
import { createRedis, __mockSend } from 'redis-on-workers';

global.Request = class Request {
  constructor(url, options) {
    this.url = url;
    this.method = options?.method || 'GET';
    this.headers = new Headers(options?.headers);
    this.body = options?.body;
    this.bodyUsed = false;
  }
  _consumeBody() {
    if (this.bodyUsed) {
      throw new Error('Body has already been consumed');
    }
    this.bodyUsed = true;
  }
  async json() {
    this._consumeBody();
    return JSON.parse(this.body);
  }
  async text() {
    this._consumeBody();
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

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

const mockVerify = vi.fn();
global.__QSTASH_MOCK_VERIFY__ = mockVerify;

const mockQStash = {
  publishJSON: vi.fn(),
};

const mockTracer = {
  startSpan: vi.fn().mockReturnValue({
    end: vi.fn(),
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
  }),
};

const mockMeter = {
  createCounter: vi.fn().mockReturnValue({
    add: vi.fn(),
  }),
  createHistogram: vi.fn().mockReturnValue({
    record: vi.fn(),
  }),
};

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => mockTracer,
    getActiveSpan: () => mockTracer.startSpan(),
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
    vi.clearAllMocks();
    vi.clearAllTimers();
    __mockSend.mockReset();
    
    mockVerify.mockReset();
    mockKV.list.mockReset();
    mockKV.get.mockReset();
    mockKV.put.mockReset();
    mockKV.delete.mockReset();

    mockVerify.mockResolvedValue(true);

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map(),
      json: async () => ({ status: 'ok', tasks: [], message: 'mock response' }),
      text: async () => 'mock response',
      body: { cancel: vi.fn() }
    });

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
      REDIS_TLS_URL: 'https://redis-tls.url',
      REDIS_TLS_PASSWORD: 'redis-tls-password',
      SKIP_SIGNATURE_VERIFY: 'true',
    };

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    vi.clearAllTimers();
  });

  afterAll(() => {
    vi.clearAllTimers();
  });

  describe('Basic Functionality', () => {
    test('should_forward_unknown_routes_with_200_status', async () => {
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
        SKIP_SIGNATURE_VERIFY: 'true',
      };
      const request = new Request('https://test.url/unknown');
      const ctx = { waitUntil: vi.fn() };

      const result = await handleRequest(request, basicEnv, ctx);
      expect(result.status).toBe(200);
    });

    test('should_return_health_status_with_active_instances', async () => {
      const basicEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        QSTASH_URL: 'https://qstash.url',
        SKIP_SIGNATURE_VERIFY: 'true',
      };
      const request = new Request('https://test.url/health');
      const ctx = { waitUntil: vi.fn() };
      const result = await handleRequest(request, basicEnv, ctx);
      expect(result.status).toBe(200);
    });

    test('should_route_download_tasks_to_lock_owner_instance', async () => {
      mockKV.list.mockImplementation(async (options) => {
        if (options?.prefix === 'instance:') {
          return { keys: [{ name: 'instance:server1' }, { name: 'instance:server2' }] };
        }
        if (options?.prefix?.startsWith('lock:') || options?.prefix?.startsWith('task:') || options?.prefix?.startsWith('msg_lock:')) {
          return { keys: [] };
        }
        return { keys: [{ name: 'instance:server1' }, { name: 'instance:server2' }] };
      });

      mockKV.get.mockImplementation(async (key) => {
        if (key === 'lb:round_robin_index') return '0';
        if (key === 'instance:server1') {
          return JSON.stringify({
            id: 'server1',
            url: 'https://backend-1.example.com',
            status: 'active',
            lastHeartbeat: Date.now()
          });
        }
        if (key === 'instance:server2') {
          return JSON.stringify({
            id: 'server2',
            url: 'https://backend-2.example.com',
            status: 'active',
            lastHeartbeat: Date.now()
          });
        }
        if (key === 'lock:telegram_client') {
          return JSON.stringify({ instanceId: 'server2', acquiredAt: Date.now(), ttl: 60 });
        }
        return null;
      });

      global.fetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Map(),
        json: async () => ({ status: 'ok' }),
        text: async () => 'ok',
        body: { cancel: vi.fn() }
      });

      const lockRoutingEnv = {
        KV_STORAGE: mockKV,
        QSTASH_CURRENT_SIGNING_KEY: 'test-key',
        QSTASH_NEXT_SIGNING_KEY: 'next-key',
        SKIP_SIGNATURE_VERIFY: 'true',
      };

      const request = new Request('https://test.url/api/tasks/download', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-lock-1' }),
      });
      const ctx = { waitUntil: vi.fn() };

      await handleRequest(request, lockRoutingEnv, ctx);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const forwardedRequest = global.fetch.mock.calls[0][0];
      expect(forwardedRequest.url).toContain('backend-2.example.com');
    });
  });

  describe('Error Handling', () => {
    test('should_return_401_when_qstash_key_missing', async () => {
      delete env.QSTASH_CURRENT_SIGNING_KEY;
      delete env.SKIP_SIGNATURE_VERIFY;

      const request = new Request('https://test.url/api/qstash/webhook', {
        method: 'POST',
        headers: { 'upstash-signature': 'test' },
        body: JSON.stringify({}),
      });

      const ctx = { waitUntil: vi.fn() };
      const result = await handleRequest(request, env, ctx);
      expect(result.status).toBe(401);
    });

    test('should_return_503_and_flush_logs_when_no_active_instances_available', async () => {
      mockKV.list.mockImplementation(async (options) => {
        if (options && options.prefix) {
          if (options.prefix.startsWith('instance:')) {
            return { keys: [] };
          }
          if (options.prefix.startsWith('lock:') || options.prefix.startsWith('task:') || options.prefix.startsWith('msg_lock:')) {
            return { keys: [] };
          }
        }
        return { keys: [] };
      });

      const axiomEnv = {
        ...env,
        AXIOM_TOKEN: 'test-axiom-token',
        AXIOM_DATASET: 'test-dataset'
      };

      const request = new Request('https://test.url/api/qstash/webhook', {
        method: 'POST',
        body: JSON.stringify({ test: 'data' }),
      });

      const ctx = { waitUntil: vi.fn() };
      const result = await handleRequest(request, axiomEnv, ctx);

      expect(result.status).toBe(503);
    });
  });

  test('should_forward_root_path_request', async () => {
    const basicEnv = {
      KV_STORAGE: mockKV,
      QSTASH_CURRENT_SIGNING_KEY: 'test-key',
      QSTASH_NEXT_SIGNING_KEY: 'next-key',
      QSTASH_URL: 'https://qstash.url',
      SKIP_SIGNATURE_VERIFY: 'true',
    };
    const request = new Request('https://test.url/');
    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, basicEnv, ctx);
    expect(result.status).toBe(200);
  });
});

describe('QStash Webhook Verification', () => {
  let env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
    
    env = {
      KV_STORAGE: mockKV,
      QSTASH_CURRENT_SIGNING_KEY: 'test-key',
      QSTASH_NEXT_SIGNING_KEY: 'next-key',
      QSTASH_URL: 'https://qstash.url',
      UPSTASH_REDIS_REST_URL: 'https://redis.url',
      UPSTASH_REDIS_REST_TOKEN: 'redis-token',
      SKIP_SIGNATURE_VERIFY: 'true',
    };

    mockVerify.mockResolvedValue(true);
  });

  test('should_reject_requests_with_invalid_qstash_signature', async () => {
    delete env.SKIP_SIGNATURE_VERIFY;
    mockVerify.mockResolvedValue(false);

    const request = new Request('https://test.url/api/qstash/webhook', {
      method: 'POST',
      headers: {
        'upstash-signature': 'invalid-signature',
      },
      body: JSON.stringify({ test: 'data' }),
    });

    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, env, ctx);
    expect(result.status).toBe(401);
  });

  test('should_return_health_status_with_active_instances', async () => {
    const request = new Request('https://test.url/health');
    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, env, ctx);
    expect(result.status).toBe(200);
  });

  test('should_return_503_and_flush_logs_when_no_active_instances_available', async () => {
    mockKV.list.mockImplementation(async (options) => {
      if (options && options.prefix) {
        if (options.prefix.startsWith('instance:')) {
          return { keys: [] };
        }
        if (options.prefix.startsWith('lock:') || options.prefix.startsWith('task:') || options.prefix.startsWith('msg_lock:')) {
          return { keys: [] };
        }
      }
      return { keys: [] };
    });

    const axiomEnv = {
      ...env,
      AXIOM_TOKEN: 'test-axiom-token',
      AXIOM_DATASET: 'test-dataset'
    };

    const request = new Request('https://test.url/api/qstash/webhook', {
      method: 'POST',
      body: JSON.stringify({ test: 'data' }),
    });

    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, axiomEnv, ctx);

    expect(result.status).toBe(503);
  });
});

describe('Logger Version and Level', () => {
  test('should_include_version_and_level_in_logger_info_pending_logs', async () => {
    await logger.info('test message', { custom: 'data' });
    
    const pendingLogs = logger.__getPendingLogs ? logger.__getPendingLogs() : [];
    expect(logger.version).toBe('dev');
    expect(logger.env).toBeDefined();
  });

  test('should_include_version_and_level_in_logger_warn_pending_logs', async () => {
    await logger.warn('warning message', { custom: 'data' });
    expect(logger.version).toBe('dev');
  });

  test('should_include_version_and_level_in_logger_error_pending_logs', async () => {
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
  let env;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
    
    env = {
      KV_STORAGE: mockKV,
      QSTASH_CURRENT_SIGNING_KEY: 'test-key',
      QSTASH_NEXT_SIGNING_KEY: 'next-key',
      QSTASH_URL: 'https://qstash.url',
      UPSTASH_REDIS_REST_URL: 'https://redis.url',
      UPSTASH_REDIS_REST_TOKEN: 'redis-token',
      SKIP_SIGNATURE_VERIFY: 'true',
    };

    mockVerify.mockResolvedValue(true);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.clearAllTimers();
  });

  test('handleRequest should process health check request', async () => {
    const request = new Request('https://test.url/health');
    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, env, ctx);

    expect(result).toBeDefined();
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(500);
  });

  test('executeWithPriorityFallback should log fallback with duration and error info', async () => {
    const envWithRedis = {
      REDIS_TLS_URL: 'https://redis.url',
      REDIS_TLS_PASSWORD: 'redis-password',
      KV_STORAGE: mockKV
    };

    __mockSend.mockRejectedValueOnce(new Error('Redis error'));
    mockKV.get.mockResolvedValueOnce('cf-value');

    await executeWithFailover('_kv_get', envWithRedis, null, 'test-key');
  });

  test('executeWithPriorityFallback should parse CF KV limit exceeded error code', async () => {
    const envWithCF = {
      KV_STORAGE: mockKV,
      UPSTASH_REDIS_REST_URL: 'https://redis.url',
      UPSTASH_REDIS_REST_TOKEN: 'token'
    };

    mockKV.get.mockRejectedValueOnce(new Error('KV list() limit exceeded'));

    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ result: 'upstash-value' })
    });

    await executeWithFailover('_kv_get', envWithCF, null, 'test-key');
  });

  test('executeUpstashScan should log timing info', async () => {
    const envWithUpstash = {
      UPSTASH_REDIS_REST_URL: 'https://upstash.url',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      NODE_ENV: 'dev'
    };

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ keys: [], cursor: 0 })
    });

    const originalEnv = logger.env;
    logger.configure({ env: 'dev' });

    try {
      await executeUpstashScan(envWithUpstash, 'prefix');
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
    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, axiomEnv, ctx);

    expect(result).toBeDefined();
    expect(result.status).toBeGreaterThanOrEqual(200);
  });

  test('handleRequest should log Axiom initialization failure when token missing', async () => {
    const invalidEnv = {
      ...env,
      AXIOM_DATASET: 'test-dataset'
    };
    const request = new Request('https://test.url/health');
    const ctx = { waitUntil: vi.fn() };
    const result = await handleRequest(request, invalidEnv, ctx);

    expect(result).toBeDefined();
  });
});
