import { vi, describe, expect, it, beforeEach, afterAll } from 'vitest';

vi.mock('../src/logger/compat.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    success: vi.fn().mockResolvedValue(undefined),
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
  updateVersionFromEnv: vi.fn(),
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
      createCounter: vi.fn(),
      createHistogram: vi.fn(),
    })),
  },
  context: {
    active: vi.fn(),
    with: vi.fn((ctx, fn) => fn()),
  },
}));

const mockKV = {
  list: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

const mockUpstashRedis = {
  get: vi.fn(),
  set: vi.fn(),
  keys: vi.fn(),
  scan: vi.fn(),
};

function createMockEnv(overrides = {}) {
  return {
    KV_STORAGE: mockKV,
    UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    REDIS_URL: undefined,
    ...overrides
  };
}

function createMockInstances(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `server${i + 1}`,
    url: `https://backend-${i + 1}.example.com`,
    status: 'active',
    lastHeartbeat: Date.now()
  }));
}

function createMockRequest(headers = {}) {
  return new Request('https://test.url/api/tasks/upload', {
    method: 'POST',
    headers: {
      'Upstash-Message-Id': 'msg_test123',
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify({ taskId: 'task-123' })
  });
}

describe('临时调度功能', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('selectInstanceByTemporaryLock', () => {
    it('should_route_to_origin_instance_when_temp_lock_exists', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_abc123' });

      mockKV.get.mockResolvedValue(JSON.stringify({
        originInstanceId: 'server1',
        timestamp: Date.now(),
        ttl: 300
      }));

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).not.toBeNull();
      expect(result.id).toBe('server1');
      expect(mockKV.get).toHaveBeenCalledWith('temp:msg:msg_abc123');
    });

    it('should_return_null_when_no_qstash_message_id', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = new Request('https://test.url/api/tasks/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'task-123' })
      });

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).toBeNull();
      expect(mockKV.get).not.toHaveBeenCalled();
    });

    it('should_return_null_when_temp_lock_not_found', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_nonexistent' });

      mockKV.get.mockResolvedValue(null);

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).toBeNull();
    });

    it('should_return_null_when_temp_lock_expired', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_expired' });

      const expiredTime = Date.now() - (400 * 1000);
      mockKV.get.mockResolvedValue(JSON.stringify({
        originInstanceId: 'server1',
        timestamp: expiredTime,
        ttl: 300
      }));

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).toBeNull();
    });

    it('should_return_null_when_origin_instance_not_active', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_inactive' });

      mockKV.get.mockResolvedValue(JSON.stringify({
        originInstanceId: 'inactive-server',
        timestamp: Date.now(),
        ttl: 300
      }));

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).toBeNull();
    });

    it('should_return_null_when_temp_lock_invalid_format', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_invalid' });

      mockKV.get.mockResolvedValue('invalid-json');

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).toBeNull();
    });

    it('should_handle_lock_with_kv_storage_format', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_kv_format' });

      mockKV.get.mockResolvedValue({
        value: JSON.stringify({
          originInstanceId: 'server2',
          timestamp: Date.now(),
          ttl: 300
        })
      });

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).not.toBeNull();
      expect(result.id).toBe('server2');
    });

    it('should_return_null_when_instances_empty', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_empty' });

      const result = await selectInstanceByTemporaryLock([], env, ctx, request);

      expect(result).toBeNull();
      expect(mockKV.get).not.toHaveBeenCalled();
    });

    it('should_handle_kv_get_error_gracefully', async () => {
      const { selectInstanceByTemporaryLock } = await import('../src/core/LoadBalancerStrategy.js');
      
      const instances = createMockInstances(2);
      const env = createMockEnv();
      const ctx = {};
      const request = createMockRequest({ 'Upstash-Message-Id': 'msg_error' });

      mockKV.get.mockRejectedValue(new Error('KV error'));

      const result = await selectInstanceByTemporaryLock(instances, env, ctx, request);

      expect(result).toBeNull();
    });
  });
});
