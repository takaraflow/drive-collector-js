import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import {
  verifyQStashSignature,
  getActiveInstances,
  selectTargetInstance,
  forwardToInstance,
  fetchWithRetry,
  shouldFailover,
  failover,
  getCurrentProvider,
  isRetryableError,
  executeWithFailover,
  getCurrentProviderState,
  setCurrentProviderState,
  logger
} from '../src/index.js';

// Mock modules handled by jest.config.js moduleNameMapper

import { Buffer } from 'node:buffer';

// Mock global.fetch
global.fetch = jest.fn();

// Mock crypto
global.crypto = {
  subtle: {
    importKey: jest.fn(),
    sign: jest.fn(),
  },
};

// Mock TextEncoder and btoa
global.TextEncoder = class TextEncoder {
  encode(str) {
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
};
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

// Mock console methods
global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

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
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
};

describe('Cloudflare Worker Load Balancer Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset global state
    setCurrentProviderState({
      currentProvider: 'cloudflare',
      failureCount: 0,
      lastFailureTime: 0
    });
  });

  describe('verifyQStashSignature', () => {
    it('应该在签名正确时返回body', async () => {
      const body = 'test-body';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'; // base64url of 'expected-signature'

      const request = {
        headers: new Map([
          ['Upstash-Signature', signature],
          ['Upstash-Timestamp', timestamp],
        ]),
        text: jest.fn().mockResolvedValue(body),
      };

      // Mock crypto
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      // Mock sign to return the bytes for 'expected-signature'
      const expectedBytes = new Uint8Array([101, 120, 112, 101, 99, 116, 101, 100, 45, 115, 105, 103, 110, 97, 116, 117, 114, 101]);
      global.crypto.subtle.sign.mockResolvedValue(expectedBytes);

      const result = await verifyQStashSignature(request, mockEnv);
      expect(result).toBe(body);
    });

    it('应该在缺少签名头时抛出错误', async () => {
      const request = {
        headers: new Map(),
        text: jest.fn().mockResolvedValue('body'),
      };

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Missing Upstash-Signature or Upstash-Timestamp header');
    });

    it('应该在签名不匹配时抛出错误', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const request = {
        headers: new Map([
          ['Upstash-Signature', 'v1a=wrong-signature'],
          ['Upstash-Timestamp', timestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
      };

      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      global.crypto.subtle.sign.mockResolvedValue(new Uint8Array(Buffer.from('expected-signature', 'utf8')));

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Signature verification failed');
    });

    it('应该在时间戳过期时抛出错误', async () => {
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 1000).toString(); // 过期1000秒，超过900秒窗口
      const request = {
        headers: new Map([
          ['Upstash-Signature', 'v1a=signature'],
          ['Upstash-Timestamp', expiredTimestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
      };

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow(/Signature expired.*now.*ts.*window/);
    });

    it('应该在SKIP_SIGNATURE_VERIFY为true时跳过验证', async () => {
      const envWithSkip = { ...mockEnv, SKIP_SIGNATURE_VERIFY: 'true' };
      const request = {
        headers: new Map(),
        text: jest.fn().mockResolvedValue('test-body'),
      };

      const result = await verifyQStashSignature(request, envWithSkip);
      expect(result).toBe('test-body');
    });

    it('应该在签名包含填充字符=时正确验证', async () => {
      const body = 'test-body';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = 'v1a=c2lnXzVQZmtKeXhjajFCQzVYOVc1aDk0TWh4bmROZ0c='; // 带填充字符的base64url

      const request = {
        headers: new Map([
          ['Upstash-Signature', signature],
          ['Upstash-Timestamp', timestamp],
        ]),
        text: jest.fn().mockResolvedValue(body),
      };

      // Mock crypto
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      // Mock sign to return bytes that base64UrlEncode produces 'c2lnXzVQZmtKeXhjajFCQzVYOVc1aDk0TWh4bmROZ0c'
      const expectedBytes = new Uint8Array(Buffer.from('c2lnXzVQZmtKeXhjajFCQzVYOVc1aDk0TWh4bmROZ0c', 'base64url'));
      global.crypto.subtle.sign.mockResolvedValue(expectedBytes);

      const result = await verifyQStashSignature(request, mockEnv);
      expect(result).toBe(body);
    });

    it('应该支持毫秒级时间戳', async () => {
      const body = 'test-body';
      const timestampMs = (Math.floor(Date.now() / 1000) * 1000).toString(); // 毫秒级时间戳
      const signature = 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'; // base64url of 'expected-signature'

      const request = {
        headers: new Map([
          ['Upstash-Signature', signature],
          ['Upstash-Timestamp', timestampMs],
        ]),
        text: jest.fn().mockResolvedValue(body),
      };

      // Mock crypto
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      const expectedBytes = new Uint8Array([101, 120, 112, 101, 99, 116, 101, 100, 45, 115, 105, 103, 110, 97, 116, 117, 114, 101]);
      global.crypto.subtle.sign.mockResolvedValue(expectedBytes);

      const result = await verifyQStashSignature(request, mockEnv);
      expect(result).toBe(body);
    });

    it('应该使用默认15分钟过期窗口', async () => {
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 1000).toString(); // 过期1000秒，超过默认900秒
      const request = {
        headers: new Map([
          ['Upstash-Signature', 'v1a=signature'],
          ['Upstash-Timestamp', expiredTimestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
      };

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Signature expired');
    });

    it('应该支持自定义过期窗口', async () => {
      const customEnv = { ...mockEnv, SIGNATURE_EXPIRATION_WINDOW: '1800' }; // 30分钟
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 1000).toString(); // 过期1000秒，小于1800秒
      const signature = 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl';

      const request = {
        headers: new Map([
          ['Upstash-Signature', signature],
          ['Upstash-Timestamp', expiredTimestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
      };

      // Mock crypto
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      const expectedBytes = new Uint8Array([101, 120, 112, 101, 99, 116, 101, 100, 45, 115, 105, 103, 110, 97, 116, 117, 114, 101]);
      global.crypto.subtle.sign.mockResolvedValue(expectedBytes);

      const result = await verifyQStashSignature(request, customEnv);
      expect(result).toBe('body');
    });
  });

  describe('getActiveInstances', () => {
    it('应该在KV为空时返回空数组', async () => {
      mockKV.list.mockResolvedValue({ keys: [] });

      const result = await getActiveInstances(mockEnv);
      expect(result).toEqual([]);
    });

    it('应该只返回活跃实例', async () => {
      const now = Date.now();
      mockKV.list.mockResolvedValue({
        keys: [
          { name: 'instance:1' },
          { name: 'instance:2' },
          { name: 'instance:3' }
        ]
      });

      mockKV.get.mockImplementation((key) => {
        if (key === 'instance:1') {
          return Promise.resolve({
            id: '1',
            url: 'https://instance1.com',
            status: 'active',
            lastHeartbeat: now - 5 * 60 * 1000, // 5分钟前
          });
        }
        if (key === 'instance:2') {
          return Promise.resolve({
            id: '2',
            url: 'https://instance2.com',
            status: 'inactive',
            lastHeartbeat: now,
          });
        }
        if (key === 'instance:3') {
          return Promise.resolve({
            id: '3',
            url: 'https://instance3.com',
            status: 'active',
            lastHeartbeat: now - 20 * 60 * 1000, // 20分钟前，过期
          });
        }
      });

      const result = await getActiveInstances(mockEnv);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('应该在KV错误时返回空数组', async () => {
      mockKV.list.mockRejectedValue(new Error('KV error'));

      const result = await getActiveInstances(mockEnv);
      expect(result).toEqual([]);
    });
  });

  describe('selectTargetInstance', () => {
    it('应该在空列表时返回null', async () => {
      const result = await selectTargetInstance([], mockEnv);
      expect(result).toBeNull();
    });

    it('应该选择第一个实例并更新索引', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];

      mockKV.get.mockResolvedValue(null); // 初始索引为0

      const result = await selectTargetInstance(instances, mockEnv);
      expect(result.id).toBe('1');

      expect(mockKV.put).toHaveBeenCalledWith('lb:round_robin_index', '1');
    });

    it('应该循环选择实例', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];

      mockKV.get.mockResolvedValue('1'); // 上次索引1

      const result = await selectTargetInstance(instances, mockEnv);
      expect(result.id).toBe('2'); // 1 % 2 = 1, instances[1]
    });
  });

  describe('forwardToInstance', () => {
    it('应该成功转发请求', async () => {
      const instance = { id: '1', url: 'https://instance1.com' };
      const request = {
        url: 'https://lb.example.com/webhook',
        method: 'POST',
        headers: new Map([
          ['Host', 'lb.example.com'],
          ['CF-Connecting-IP', '1.2.3.4'],
        ]),
      };
      const originalBody = 'test-body';

      const mockResponse = { status: 200, ok: true };
      global.fetch.mockResolvedValue(mockResponse);

      const result = await forwardToInstance(instance, request, originalBody);
      expect(result).toBe(mockResponse);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://instance1.com/webhook',
          method: 'POST',
        })
      );
    });

    it('应该在5xx错误时抛出异常', async () => {
      const instance = { id: '1', url: 'https://instance1.com' };
      const request = {
        url: 'https://lb.example.com/webhook',
        method: 'POST',
        headers: new Map(),
      };
      const originalBody = 'test-body';

      const mockResponse = { status: 500 };
      global.fetch.mockResolvedValue(mockResponse);

      await expect(forwardToInstance(instance, request, originalBody)).rejects.toThrow();
    });
  });

  describe('fetchWithRetry', () => {
    it('应该在第一个实例成功时返回响应', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };

      const mockResponse = { status: 200 };
      global.fetch.mockResolvedValue(mockResponse);

      const result = await fetchWithRetry(instances, request, mockEnv, request.body);
      expect(result).toBe(mockResponse);
    });

    it('应该在第一个失败时尝试下一个实例', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };

      global.fetch.mockImplementationOnce(() => Promise.resolve({ status: 500 }));
      const mockResponse = { status: 200 };
      global.fetch.mockResolvedValueOnce(mockResponse);

      const result = await fetchWithRetry(instances, request, mockEnv, request.body);
      expect(result).toBe(mockResponse);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('应该在所有实例失败时抛出错误', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };

      global.fetch.mockResolvedValue({ status: 500 });

      await expect(fetchWithRetry(instances, request, mockEnv, request.body)).rejects.toThrow('Instance 2 returned 500');
    });
  });

  describe('Fault Tolerance Functions', () => {
    beforeEach(() => {
      // Reset global state
      setCurrentProviderState({
        currentProvider: 'cloudflare',
        failureCount: 0,
        lastFailureTime: 0
      });
    });

    afterEach(() => {
      // Reset to cloudflare after tests
      setCurrentProviderState({
        currentProvider: 'cloudflare',
        failureCount: 0,
        lastFailureTime: 0
      });
    });

    describe('shouldFailover', () => {
      it('应该在配额错误且达到最大失败次数时返回true', () => {
        const error = new Error('free usage limit exceeded');
        const env = { UPSTASH_REDIS_REST_URL: 'test', UPSTASH_REDIS_REST_TOKEN: 'test' };

        // 模拟多次失败
        for (let i = 0; i < 3; i++) {
          expect(shouldFailover(error, env)).toBe(i === 2);
        }
      });

      it('应该在没有Upstash配置时返回false', () => {
        const error = new Error('free usage limit exceeded');
        const env = {};

        expect(shouldFailover(error, env)).toBe(false);
      });

      it('应该在已经是upstash模式时返回false', () => {
        // 先设置成upstash模式
        setCurrentProviderState({ currentProvider: 'upstash' });

        const error = new Error('free usage limit exceeded');
        const env = { UPSTASH_REDIS_REST_URL: 'test', UPSTASH_REDIS_REST_TOKEN: 'test' };

        expect(shouldFailover(error, env)).toBe(false);
      });
    });

    describe('failover', () => {
      it('应该成功切换到upstash', () => {
        const env = { UPSTASH_REDIS_REST_URL: 'test', UPSTASH_REDIS_REST_TOKEN: 'test' };

        expect(failover(env)).toBe(true);
        expect(getCurrentProvider()).toBe('Upstash Redis');
      });

      it('应该在没有配置时返回false', () => {
        const env = {};

        expect(failover(env)).toBe(false);
      });
    });

    describe('isRetryableError', () => {
      it('应该识别配额错误', () => {
        expect(isRetryableError(new Error('free usage limit'))).toBe(true);
        expect(isRetryableError(new Error('quota exceeded'))).toBe(true);
        expect(isRetryableError(new Error('rate limit'))).toBe(true);
        expect(isRetryableError(new Error('network timeout'))).toBe(true);
      });

      it('应该返回false对于不可重试错误', () => {
        expect(isRetryableError(new Error('key not found'))).toBe(false);
        expect(isRetryableError(new Error('invalid argument'))).toBe(false);
      });
    });

    describe('executeWithFailover', () => {
      it('应该在KV成功时使用Cloudflare KV', async () => {
        mockKV.get.mockResolvedValue('test-value');

        const result = await executeWithFailover('_kv_get', mockEnv, {}, 'test-key');
        expect(result).toBe('test-value');
        expect(mockKV.get).toHaveBeenCalledWith('test-key');
      });

      it('应该在KV失败时故障转移到Upstash', async () => {
        // Mock Upstash response
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ result: 'upstash-value' })
        });

        // Mock KV failure
        mockKV.get.mockRejectedValue(new Error('free usage limit exceeded'));

        // 多次调用以触发故障转移
        for (let i = 0; i < 3; i++) {
          try {
            await executeWithFailover('_kv_get', mockEnv, 'test-key');
          } catch (e) {
            // 忽略
          }
        }

        // 现在应该在upstash模式
        const result = await executeWithFailover('_kv_get', mockEnv, {}, 'test-key');
        expect(result).toBe('upstash-value');
        expect(global.fetch).toHaveBeenCalledWith(
          'https://test.upstash.io/get/test-key',
          expect.objectContaining({
            headers: { 'Authorization': 'Bearer test-token' }
          })
        );
      });
    });
  });


  // 集成测试
  describe('Integration Tests', () => {
    it('应该在happy path下成功转发请求', async () => {
      // Mock 签名验证
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      global.crypto.subtle.sign.mockResolvedValue(new Uint8Array(Buffer.from('expected-signature', 'utf8')));

      // Mock KV
      mockKV.list.mockResolvedValue({
        keys: [{ name: 'instance:1' }]
      });
      mockKV.get.mockImplementation((key) => {
        if (key === 'instance:1') {
          return Promise.resolve({
            id: '1',
            url: 'https://instance1.com',
            status: 'active',
            lastHeartbeat: Date.now(),
          });
        }
        if (key === 'lb:round_robin_index') {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      });

      // Mock fetch
      const mockResponse = { status: 200, headers: new Map() };
      global.fetch.mockResolvedValue(mockResponse);

      const request = {
        url: 'https://lb.example.com/webhook',
        method: 'POST',
        headers: new Map([
          ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
          ['Upstash-Timestamp', Math.floor(Date.now() / 1000).toString()],
        ]),
        text: jest.fn().mockResolvedValue('body'),
      };

      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(200);
    });

    it('应该在无活跃实例时返回503', async () => {
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      global.crypto.subtle.sign.mockResolvedValue(new Uint8Array(Buffer.from('expected-signature', 'utf8')));

      mockKV.list.mockResolvedValue({ keys: [] });

      const request = {
        headers: new Map([
          ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
          ['Upstash-Timestamp', Math.floor(Date.now() / 1000).toString()],
        ]),
        text: jest.fn().mockResolvedValue('body'),
      };

      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(503);
    });

    it('应该在签名验证失败时返回401', async () => {
      const request = {
        headers: new Map(),
        text: jest.fn().mockResolvedValue('body'),
      };

      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(401);
    });

    it('应该在GET /health请求时返回200', async () => {
      const request = {
        url: 'https://lb.example.com/health',
        method: 'GET',
        headers: new Map(),
      };

      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(200);
    });

    it('应该正确转发 type="download" 的 QStash 请求', async () => {
      const downloadBody = JSON.stringify({
        id: "task_123456789",
        chatId: "chat_987654321",
        msgId: 123456789,
        type: "download"
      });

      // Mock 签名验证
      global.crypto.subtle.importKey.mockResolvedValue('mock-key');
      global.crypto.subtle.sign.mockResolvedValue(new Uint8Array(Buffer.from('expected-signature', 'utf8')));

      // Mock KV
      mockKV.list.mockResolvedValue({
        keys: [{ name: 'instance:1' }]
      });
      mockKV.get.mockImplementation((key) => {
        if (key === 'instance:1') {
          return Promise.resolve({
            id: '1',
            url: 'https://instance1.com',
            status: 'active',
            lastHeartbeat: Date.now(),
          });
        }
        if (key === 'lb:round_robin_index') {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      });

      // Mock fetch
      const mockResponse = { status: 200, headers: new Map() };
      let capturedRequest;
      global.fetch = jest.fn().mockImplementation((req) => {
        capturedRequest = req;
        return Promise.resolve(mockResponse);
      });

      const request = {
        url: 'https://lb.example.com/',
        method: 'POST',
        headers: new Map([
          ['Content-Type', 'application/json'],
          ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
          ['Upstash-Timestamp', Math.floor(Date.now() / 1000).toString()],
        ]),
        text: jest.fn().mockResolvedValue(downloadBody),
      };

      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(200);

      // 验证 fetch 被调用时使用了正确的 body
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(capturedRequest).toBeInstanceOf(Request);
      expect(await capturedRequest.text()).toBe(downloadBody);
    });
  });
});