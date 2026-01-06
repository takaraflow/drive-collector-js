// 新功能测试 - 任务调度失败处理优化
import { jest } from '@jest/globals';

// 确保全局 Web API 可用
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

// Mock global.fetch (already in setup, but per-test override if needed)
// Note: global.fetch is already mocked in jest.setup.js

// Helper function to create mock response with body.cancel
function createMockResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        body: {
            cancel: jest.fn().mockResolvedValue(undefined)
        },
        text: jest.fn(() => '{}'),
        json: jest.fn(() => ({})),
        ...body
    };
}

// Mock @upstash/qstash
const mockVerify = jest.fn();
global.__QSTASH_MOCK_VERIFY__ = mockVerify;

jest.mock('@upstash/qstash', () => ({
  Receiver: class {
    constructor(options) {
      this.currentSigningKey = options.currentSigningKey;
      this.nextSigningKey = options.nextSigningKey;
    }
    
    async verify(options) {
      return mockVerify(options);
    }
  },
}));

// 导入需要测试的函数
import { describe, expect, it, beforeEach, afterEach, afterAll } from '@jest/globals';
import {
  fetchWithRetry,
  getActiveInstances,
  detectCacheProvider,
  normalizePath,
  executeRedis,
  scanLockKeys,
  executeWithFailover,
  __test_setRedisClient
} from '../src/index.js';
import { __mockSend, createRedis } from 'redis-on-workers';

// Mock KV Storage
const mockKV = {
  list: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
};

const mockEnv = {
  KV_STORAGE: mockKV,
  QSTASH_CURRENT_SIGNING_KEY: 'test-secret-key',
  UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'test-password',
};

describe('任务调度失败处理优化测试', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    __mockSend.mockReset();
    mockVerify.mockReset();
    mockVerify.mockImplementation(async (options) => {
      return options.body;
    });
    global.__QSTASH_MOCK_VERIFY__ = mockVerify;
    global.fetch.mockReset();
    
    // Pre-mock the redis client for all tests in this suite
    const mockClient = createRedis({});
    __test_setRedisClient(mockClient);

    // Suppress console output during tests
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });
  
  afterEach(() => {
    if (typeof __test_setRedisClient === 'function') {
      __test_setRedisClient(null);
    }
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('fetchWithRetry - 4xx Stop Retry Logic', () => {
   it('should_stop_retry_immediately_on_4xx_response_and_forward', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response400 = createMockResponse(400, { 
        text: () => Promise.resolve('Bad Request'),
        headers: new Map([['Content-Type', 'application/json']])
      });
      
      global.fetch.mockResolvedValueOnce(response400);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      expect(result.status).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should_stop_retry_on_422_unprocessable_entity', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response422 = createMockResponse(422, { 
        text: () => Promise.resolve('Unprocessable Entity'),
        headers: new Map([['Content-Type', 'application/json']])
      });
      
      global.fetch.mockResolvedValueOnce(response422);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      expect(result.status).toBe(422);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should_stop_retry_on_401_unauthorized', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response401 = createMockResponse(401, { 
        text: () => Promise.resolve('Unauthorized'),
        headers: new Map([['Content-Type', 'application/json']])
      });
      
      global.fetch.mockResolvedValueOnce(response401);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      expect(result.status).toBe(401);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should_cancel_500_response_when_4xx_received_from_fallback', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response500 = createMockResponse(500);
      const response400 = createMockResponse(400, {
        text: () => Promise.resolve('Bad Request'),
        headers: new Map([['Content-Type', 'application/json']])
      });
      
      global.fetch.mockResolvedValueOnce(response500);
      global.fetch.mockResolvedValueOnce(response400);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      expect(result.status).toBe(400);
      expect(response500.body.cancel).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Contract Path Normalization', () => {
   it('should_normalize_download_tasks_path_to_download_endpoint', () => {
       expect(normalizePath('/api/tasks/download-tasks')).toBe('/api/tasks/download');
     });
 
     it('should_normalize_upload_tasks_path_to_upload_endpoint', () => {
       expect(normalizePath('/api/tasks/upload-tasks')).toBe('/api/tasks/upload');
     });
 
     it('应该将 /api/tasks/media-batch 保持不变', () => {
       expect(normalizePath('/api/tasks/media-batch')).toBe('/api/tasks/media-batch');
     });
 
     it('应该将未知路径保持不变', () => {
       expect(normalizePath('/api/other/path')).toBe('/api/other/path');
     });
 
     it('should_log_path_normalization_in_handleRequest', async () => {
       const timestamp = Math.floor(Date.now() / 1000).toString();
       mockVerify.mockResolvedValue('body');
       mockKV.list.mockResolvedValue({ keys: [{ name: 'instance:1' }] });
       mockKV.get.mockResolvedValue({
         id: '1',
         url: 'https://instance1.com',
         status: 'active',
         lastHeartbeat: Date.now(),
       });
 
       global.fetch.mockResolvedValueOnce(createMockResponse(200, {
         text: () => Promise.resolve('OK'),
         headers: new Map([['Content-Type', 'text/plain']])
       }));
 
       const request = {
         url: 'https://lb.example.com/api/tasks/download-tasks',
         method: 'POST',
         headers: new Map([
           ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
           ['Upstash-Timestamp', timestamp],
         ]),
         text: jest.fn().mockResolvedValue('body'),
         arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
       };
 
       consoleLogSpy.mockClear();
       
       const lb = await import('../src/index.js');
       await lb.default.fetch(request, mockEnv, {});
 
       // 验证路径映射被记录
       const logCalls = consoleLogSpy.mock.calls;
       const hasMappingLog = logCalls.some(call => {
         const message = call[0];
         const meta = call[1];
         return message.includes('路径规范化') &&
                meta.original === '/api/tasks/download-tasks' &&
                meta.normalized === '/api/tasks/download';
       });
       expect(hasMappingLog).toBe(true);
     });
   });
 
    describe('Multi-prefix Instance Scanning', () => {
     it('should_scan_all_contract_key_prefixes', async () => {
       mockKV.list
         .mockResolvedValueOnce({ keys: [{ name: 'instance:1' }] })
         .mockResolvedValueOnce({ keys: [{ name: 'lock:task1' }] })
         .mockResolvedValueOnce({ keys: [{ name: 'task:123' }] })
         .mockResolvedValueOnce({ keys: [{ name: 'msg_lock:msg1' }] });
 
       mockKV.get.mockResolvedValue({
         id: '1',
         url: 'https://instance1.com',
         status: 'active',
         lastHeartbeat: Date.now(),
       });
 
       const result = await getActiveInstances(mockEnv, {});
       
       expect(result.length).toBe(1);
       expect(result[0].id).toBe('1');
       // 验证 list 被调用了4次（每个前缀一次）
       expect(mockKV.list).toHaveBeenCalledTimes(7);
     });
 
     it('should_scan_lock_keys_and_return_count', async () => {
       mockKV.list
         .mockResolvedValueOnce({ keys: [{ name: 'lock:1' }, { name: 'lock:2' }] })
         .mockResolvedValueOnce({ keys: [{ name: 'task:1' }] })
         .mockResolvedValueOnce({ keys: [{ name: 'msg_lock:1' }] });
 
       const result = await scanLockKeys(mockEnv, {});
       
       expect(result).toBe(4); // 2 + 1 + 1
     });
 
     it('should_handle_partial_prefix_scan_failures', async () => {
       mockKV.list
         .mockRejectedValueOnce(new Error('KV error'))
         .mockResolvedValueOnce({ keys: [{ name: 'lock:1' }] })
         .mockResolvedValueOnce({ keys: [] })
         .mockResolvedValueOnce({ keys: [] });
 
       mockKV.get.mockResolvedValue({
         id: '1',
         url: 'https://instance1.com',
         status: 'active',
         lastHeartbeat: Date.now(),
       });
 
       const result = await getActiveInstances(mockEnv, {});
       
       expect(result.length).toBe(0); // 没有 instance:* 键
     });
   });
 
    describe('Cache Provider Detection', () => {
     it('should_prioritize_CACHE_PROVIDER_env_variable', () => {
       const env = { CACHE_PROVIDER: 'redis' };
       expect(detectCacheProvider(env)).toBe('redis');
     });
 
     it('should_detect_redis_tls_with_password', () => {
       const env = { REDIS_TLS_URL: 'https://redis.example.com', REDIS_TLS_PASSWORD: 'password' };
       expect(detectCacheProvider(env)).toBe('redis');
     });
 
     it('应该检测 Cloudflare KV', () => {
       const env = { KV_STORAGE: mockKV };
       expect(detectCacheProvider(env)).toBe('cloudflare');
     });
 
     it('应该检测 Upstash', () => {
       const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.com', UPSTASH_REDIS_REST_TOKEN: 'token' };
       expect(detectCacheProvider(env)).toBe('upstash');
     });
 
     it('should_prioritize_redis_tls_over_cloudflare_kv_and_upstash', () => {
       const env = {
         KV_STORAGE: mockKV,
         UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
         UPSTASH_REDIS_REST_TOKEN: 'token',
         REDIS_TLS_URL: 'https://redis-tls.example.com',
         REDIS_TLS_PASSWORD: 'password'
       };
       expect(detectCacheProvider(env)).toBe('redis');
     });
 
     it('应该优先 Cloudflare KV > Upstash', () => {
       const env = {
         KV_STORAGE: mockKV,
         UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
         UPSTASH_REDIS_REST_TOKEN: 'token'
       };
       expect(detectCacheProvider(env)).toBe('cloudflare');
     });
 
     it('应该返回 none 当无提供者', () => {
       const env = {};
       expect(detectCacheProvider(env)).toBe('none');
     });
   });
 
    describe('Redis 故障转移', () => {
     it('应该执行 Redis GET 操作', async () => {
       const env = {
         REDIS_TLS_URL: 'https://redis.example.com',
         REDIS_TLS_PASSWORD: 'test-password',
       };

       __mockSend.mockResolvedValueOnce('test-value');

       const result = await executeRedis('_redis_get', env, 'test-key');
       
       expect(result).toBe('test-value');
       expect(__mockSend).toHaveBeenCalledWith('GET', 'test-key');
     });

     it('应该执行 Redis PUT 操作', async () => {
       const env = {
         REDIS_TLS_URL: 'https://redis.example.com',
         REDIS_TLS_PASSWORD: 'test-password',
       };

       __mockSend.mockResolvedValueOnce('OK');

       const result = await executeRedis('_redis_put', env, 'test-key', 'test-value');
       
       expect(result).toBe(true);
       expect(__mockSend).toHaveBeenCalledWith('SET', 'test-key', 'test-value');
     });

     it('应该处理 Redis 404 返回 null', async () => {
       const env = {
         REDIS_TLS_URL: 'https://redis.example.com',
         REDIS_TLS_PASSWORD: 'test-password',
       };

       __mockSend.mockResolvedValueOnce(null);

       const result = await executeRedis('_redis_get', env, 'nonexistent-key');
       
       expect(result).toBe(null);
     });

     it('应该在 executeWithFailover 中使用 Redis 作为第一优先级', async () => {
       const env = {
         KV_STORAGE: mockKV,
         UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
         UPSTASH_REDIS_REST_TOKEN: 'test-password',
         REDIS_TLS_URL: 'https://redis.example.com',
         REDIS_TLS_PASSWORD: 'redis-password',
       };

       __mockSend.mockResolvedValueOnce('redis-value');

       const result = await executeWithFailover('_kv_get', env, {}, 'test-key');
       
       expect(result).toBe('redis-value');
     });

     it('应该在 Redis 失败时 fallback 到 CF KV', async () => {
       const env = {
         KV_STORAGE: mockKV,
         REDIS_TLS_URL: 'https://redis.example.com',
         REDIS_TLS_PASSWORD: 'redis-password',
       };

       __mockSend.mockRejectedValueOnce(new Error('Redis error'));
       
       // CF KV 成功
       mockKV.get.mockResolvedValueOnce('cf-value');

       const result = await executeWithFailover('_kv_get', env, {}, 'test-key');
       
       expect(result).toBe('cf-value');
     });

     it('应该在 Redis TLS 和 CF KV 都失败时 fallback 到 Upstash', async () => {
       const env = {
         KV_STORAGE: mockKV,
         UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
         UPSTASH_REDIS_REST_TOKEN: 'test-password',
         REDIS_TLS_URL: 'https://redis.example.com',
         REDIS_TLS_PASSWORD: 'redis-password',
       };

       __mockSend.mockRejectedValueOnce(new Error('Redis error'));
       
       // CF KV 失败
       mockKV.get.mockRejectedValueOnce(new Error('KV error'));
       
       // Upstash 成功
       global.fetch.mockResolvedValueOnce({
         ok: true,
         json: async () => ({ result: 'upstash-value' }),
       });

       const result = await executeWithFailover('_kv_get', env, {}, 'test-key');
       
       expect(result).toBe('upstash-value');
     });
   });
 
    describe('路径映射与负载均衡集成', () => {
     it('应该在转发前规范化契约路径', async () => {
       const timestamp = Math.floor(Date.now() / 1000).toString();
       mockVerify.mockResolvedValue('body');
       mockKV.list.mockResolvedValue({ keys: [{ name: 'instance:1' }] });
       mockKV.get.mockResolvedValue({
         id: '1',
         url: 'https://instance1.com',
         status: 'active',
         lastHeartbeat: Date.now(),
       });
 
       // 模拟实例返回成功
       global.fetch.mockResolvedValueOnce(createMockResponse(200, {
         text: () => Promise.resolve('OK'),
         headers: new Map([['Content-Type', 'text/plain']])
       }));
 
       const request = {
         url: 'https://lb.example.com/api/tasks/download-tasks',
         method: 'POST',
         headers: new Map([
           ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
           ['Upstash-Timestamp', timestamp],
         ]),
         text: jest.fn().mockResolvedValue('body'),
         arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
       };
 
       consoleLogSpy.mockClear();
       
       const lb = await import('../src/index.js');
       await lb.default.fetch(request, mockEnv, {});
 
       // 验证路径映射被记录
       const logCalls = consoleLogSpy.mock.calls;
       const hasMappingLog = logCalls.some(call => {
         const message = call[0];
         const meta = call[1];
         return message.includes('路径规范化') &&
                meta.original === '/api/tasks/download-tasks' &&
                meta.normalized === '/api/tasks/download';
       });
       expect(hasMappingLog).toBe(true);
     });
   });
 
    describe('fetchWithRetry - 5xx 透传逻辑', () => {
     it('应该在所有实例都返回5xx时返回最后一个5xx响应', async () => {
       const instances = [
         { id: '1', url: 'https://instance1.com' },
         { id: '2', url: 'https://instance2.com' },
       ];
       const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
       const normalizedUrl = new URL(request.url);
       normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');
 
       const response500 = createMockResponse(500);
       const response503 = createMockResponse(503);
       
       global.fetch.mockResolvedValueOnce(response500);
       global.fetch.mockResolvedValueOnce(response503);
 
       const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
       
       // 应该返回最后一个5xx响应
       expect(result.status).toBe(503);
       expect(response500.body.cancel).toHaveBeenCalled();
       expect(response503.body.cancel).not.toHaveBeenCalled();
     });
   });
 
  describe('getActiveInstances - No Active Instances Handling', () => {
     it('should_return_empty_array_when_no_active_instances', async () => {
       mockKV.list.mockResolvedValue({ keys: [] });
 
       const result = await getActiveInstances(mockEnv, {});
       expect(result).toEqual([]);
     });
 
    it('should_return_empty_array_when_all_instances_expired', async () => {
      const now = Date.now();
      mockKV.list.mockResolvedValue({
        keys: [{ name: 'instance:1' }, { name: 'instance:2' }]
      });
 
       mockKV.get.mockImplementation((key) => {
         return Promise.resolve({
           id: key === 'instance:1' ? '1' : '2',
           url: key === 'instance:1' ? 'https://instance1.com' : 'https://instance2.com',
           status: 'active',
           lastHeartbeat: now - 60 * 60 * 1000, // 1小时前，已过期
         });
       });
 
      const result = await getActiveInstances(mockEnv, {});
      expect(result).toEqual([]);
    });
  });

  describe('getActiveInstances - Heartbeat Parsing', () => {
   it('should_accept_iso_lastHeartbeat_string', async () => {
     const now = new Date();
     mockKV.list.mockImplementation(async (options) => {
       if (options && options.prefix) {
         if (options.prefix.startsWith('instance:')) {
           return { keys: [{ name: 'instance:1' }] };
         }
         return { keys: [] };
       }
       return { keys: [] };
     });

     mockKV.get.mockResolvedValue(JSON.stringify({
       id: '1',
       url: 'https://instance1.com',
       status: 'active',
       lastHeartbeat: now.toISOString(),
     }));

     const result = await getActiveInstances(mockEnv, {});
     expect(result.length).toBe(1);
     expect(result[0].id).toBe('1');
   });

   it('should_accept_epoch_seconds_lastHeartbeat', async () => {
     const nowSeconds = Math.floor(Date.now() / 1000);
     mockKV.list.mockImplementation(async (options) => {
       if (options && options.prefix) {
         if (options.prefix.startsWith('instance:')) {
           return { keys: [{ name: 'instance:1' }] };
         }
         return { keys: [] };
       }
       return { keys: [] };
     });

     mockKV.get.mockResolvedValue(JSON.stringify({
       id: '1',
       url: 'https://instance1.com',
       status: 'active',
       lastHeartbeat: nowSeconds,
     }));

     const result = await getActiveInstances(mockEnv, {});
     expect(result.length).toBe(1);
     expect(result[0].id).toBe('1');
   });
  });
 
    describe('QStash 元数据记录', () => {
     it('应该在无活跃实例时记录 QStash 元数据到日志', async () => {
       const timestamp = Math.floor(Date.now() / 1000).toString();
       mockVerify.mockResolvedValue('body');
       mockKV.list.mockResolvedValue({ keys: [] });
 
       const request = {
         url: 'https://lb.example.com/webhook',
         headers: new Map([
           ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
           ['Upstash-Timestamp', timestamp],
           ['Upstash-Message-Id', 'msg_test_123'],
           ['Upstash-Retries', '3'],
         ]),
         text: jest.fn().mockResolvedValue('body'),
         arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
       };
 
       consoleWarnSpy.mockClear();
       
       const lb = await import('../src/index.js');
       const response = await lb.default.fetch(request, mockEnv, {});
 
       expect(response.status).toBe(503);
       
       // 验证 console.warn 被调用并包含元数据
       expect(consoleWarnSpy).toHaveBeenCalled();
       const warnCalls = consoleWarnSpy.mock.calls;
       const hasMetadata = warnCalls.some(call => {
         const message = call[0];
         const meta = call[1];
         return message.includes('无活跃实例可用') && 
                meta.qstashMsgId === 'msg_test_123' && 
                meta.retryCount === '3';
       });
       expect(hasMetadata).toBe(true);
     });
 
     it('应该在签名验证失败时记录 QStash 元数据到日志', async () => {
       const timestamp = Math.floor(Date.now() / 1000).toString();
       mockVerify.mockRejectedValue(new Error('Signature verification failed'));
 
       const request = {
         url: 'https://lb.example.com/webhook',
         headers: new Map([
           ['Upstash-Message-Id', 'msg_error_456'],
           ['Upstash-Retries', '1'],
         ]),
         text: jest.fn().mockResolvedValue('body'),
         arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
       };
 
       consoleWarnSpy.mockClear();
       
       const lb = await import('../src/index.js');
       const response = await lb.default.fetch(request, mockEnv, {});
 
       expect(response.status).toBe(401);
       
       // 验证警告日志包含元数据
       const warnCalls = consoleWarnSpy.mock.calls;
       const hasMetadata = warnCalls.some(call => {
         const message = call[0];
         const meta = call[1];
         return message.includes('签名验证失败') && 
                meta.qstashMsgId === 'msg_error_456' && 
                meta.retryCount === '1';
       });
       expect(hasMetadata).toBe(true);
     });
   });
 
    describe('Retry-After 头部', () => {
     it('应该在返回503时包含Retry-After头部', async () => {
       const timestamp = Math.floor(Date.now() / 1000).toString();
       mockVerify.mockResolvedValue('body');
       mockKV.list.mockResolvedValue({ keys: [] });
 
       const request = {
         url: 'https://lb.example.com/webhook',
         headers: new Map([
           ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
           ['Upstash-Timestamp', timestamp],
         ]),
         text: jest.fn().mockResolvedValue('body'),
         arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
       };
 
       const lb = await import('../src/index.js');
       const response = await lb.default.fetch(request, mockEnv, {});
 
       expect(response.status).toBe(503);
       expect(response.headers.get('Retry-After')).toBe('60');
     });
   });
 
    describe('响应体包含 QStash 元数据', () => {
     it('应该在错误响应体中包含 qstashMsgId', async () => {
       const timestamp = Math.floor(Date.now() / 1000).toString();
       mockVerify.mockResolvedValue('body');
       mockKV.list.mockResolvedValue({ keys: [] });
 
       const request = {
         url: 'https://lb.example.com/webhook',
         headers: new Map([
           ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
           ['Upstash-Timestamp', timestamp],
           ['Upstash-Message-Id', 'msg_response_test'],
         ]),
         text: jest.fn().mockResolvedValue('body'),
         arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
       };
 
       const lb = await import('../src/index.js');
       const response = await lb.default.fetch(request, mockEnv, {});
 
       const body = await response.json();
       expect(body.qstashMsgId).toBe('msg_response_test');
       expect(body.timestamp).toBeDefined();
       expect(body.error).toBeDefined();
     });
   });
 });
