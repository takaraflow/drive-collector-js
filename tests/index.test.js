import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { handleRequest } from '../src/index.js';

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
    this.headers = new Map(Object.entries(options?.headers || {}));
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
    mockKV.list.mockImplementation(async () => {
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
      const request = new Request('https://test.url/unknown');
      const result = await handleRequest(request, env);
      expect(result.status).toBe(200);
    });

    test('should handle health check', async () => {
      const request = new Request('https://test.url/health');
      const result = await handleRequest(request, env);
      expect(result.status).toBe(200);
      const text = await result.text();
      expect(text).toBe('LB is running');
    });

    test('should handle root path (forwarded)', async () => {
      const request = new Request('https://test.url/');
      const result = await handleRequest(request, env);
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
      delete env.SKIP_SIGNATURE_VERIFY;
      mockVerify.mockResolvedValue(true);

      const request = new Request('https://test.url/api/qstash/webhook', {
        method: 'POST',
        headers: {
          'upstash-signature': 'valid-signature',
        },
        body: JSON.stringify({ test: 'data' }),
      });

      const result = await handleRequest(request, env);
      expect(result.status).toBe(200);
    });
  });



  describe('Task Operations', () => {
    test('should download tasks', async () => {
      const request = new Request('https://test.url/api/tasks/download-tasks');
      const result = await handleRequest(request, env);
      expect(result.status).toBe(200);
      const data = await result.json();
      expect(data.tasks).toBeDefined(); // Assumes default mock fetch returns { tasks: [] }
    });

    test('should handle task upload', async () => {
      const request = new Request('https://test.url/api/tasks/upload', {
        method: 'POST',
        body: JSON.stringify({ tasks: [{ id: 'task1' }] }),
      });

      const result = await handleRequest(request, env);
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
});