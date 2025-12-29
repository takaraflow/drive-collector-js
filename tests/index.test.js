// 首先设置 mock，然后再导入模块
import { jest } from '@jest/globals';

// 确保全局 Web API 可用
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

// Mock global.fetch
global.fetch = jest.fn();

// Helper function to create mock response with body.cancel
function createMockResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        body: {
            cancel: jest.fn().mockResolvedValue(undefined)
        },
        ...body
    };
}

// Mock console methods
global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock @upstash/qstash - 使用全局变量注入
const mockVerify = jest.fn();

// 设置全局 mock 验证器
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

// 现在导入测试的函数
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
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
  logger,
  upstash_get
} from '../src/index.js';

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
    // 重置 mock 实现并重新设置默认行为
    mockVerify.mockReset();
    mockVerify.mockImplementation(async (options) => {
      // 模拟验证成功，返回传入的 body
      return options.body;
    });
    // 确保全局 mock 存在
    global.__QSTASH_MOCK_VERIFY__ = mockVerify;
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
        url: 'https://test.url',
      };

      // mockVerify 返回 body，表示验证通过
      mockVerify.mockResolvedValue(body);

      const result = await verifyQStashSignature(request, mockEnv);
      
      // 验证 mock 被调用
      expect(mockVerify).toHaveBeenCalledWith({
        signature,
        body,
        url: 'https://test.url',
      });
      
      expect(new TextDecoder().decode(result)).toBe(body);
    });

    it('应该在缺少签名头时抛出错误', async () => {
      const request = {
        headers: new Map(),
        text: jest.fn().mockResolvedValue('body'),
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('body')),
      };

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Missing Upstash-Signature header');
    });

    it('应该在签名不匹配时抛出错误', async () => {
      const request = {
        headers: new Map([
          ['Upstash-Signature', 'wrong-signature'],
          ['Upstash-Timestamp', Math.floor(Date.now() / 1000).toString()],
        ]),
        text: jest.fn().mockResolvedValue('body'),
        url: 'https://test.url/api',
      };

      mockVerify.mockRejectedValue(new Error('Invalid signature'));
      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Signature verification failed: Invalid signature');
    });

    it('应该在时间戳过期时抛出错误', async () => {
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 1000).toString(); // 过期1000秒
      const request = {
        headers: new Map([
          ['Upstash-Signature', 'expired-signature'],
          ['Upstash-Timestamp', expiredTimestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
        url: 'https://test.url/api',
      };

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Signature expired');
    });

    it('应该在SKIP_SIGNATURE_VERIFY为true时跳过验证', async () => {
      const envWithSkip = { ...mockEnv, SKIP_SIGNATURE_VERIFY: 'true' };
      const request = {
        headers: new Map(),
        text: jest.fn().mockResolvedValue('test-body'),
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('test-body')),
      };

      const result = await verifyQStashSignature(request, envWithSkip);
      expect(result).toEqual(new Uint8Array(Buffer.from('test-body')));
    });

    it('应该在签名包含填充字符=时正确验证', async () => {
      const body = 'test-body';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = 'v1a=c2lnXVZmtKeXhjajFCQzVYOVc1aDk0TWh4bmROZ0c='; // 带填充字符的base64url

      const request = {
        headers: new Map([
          ['Upstash-Signature', signature],
          ['Upstash-Timestamp', timestamp],
        ]),
        text: jest.fn().mockResolvedValue(body),
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from(body)),
      };

      mockVerify.mockResolvedValue(body);

      const result = await verifyQStashSignature(request, mockEnv);
      expect(new TextDecoder().decode(result)).toBe(body);
    });

    it('应该使用默认15分钟过期窗口', async () => {
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 1000).toString(); // 过期1000秒，超过默认900秒
      const request = {
        headers: new Map([
          ['Upstash-Signature', 'v1a=signature'],
          ['Upstash-Timestamp', expiredTimestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('body')),
      };

      await expect(verifyQStashSignature(request, mockEnv)).rejects.toThrow('Signature expired');
    });

    it('应该支持自定义过期窗口', async () => {
      const body = 'test-body';
      const customEnv = { ...mockEnv, SIGNATURE_EXPIRATION_WINDOW: '1800' }; // 30分钟
      const expiredTimestamp = (Math.floor(Date.now() / 1000) - 1000).toString(); // 过期1000秒，小于1800秒
      const signature = 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl';

      const request = {
        headers: new Map([
          ['Upstash-Signature', signature],
          ['Upstash-Timestamp', expiredTimestamp],
        ]),
        text: jest.fn().mockResolvedValue(body),
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from(body)),
      };

      mockVerify.mockResolvedValue(body);

      const result = await verifyQStashSignature(request, customEnv);
      expect(new TextDecoder().decode(result)).toBe(body);
    });

    it('应该支持 JWT 格式签名（不带 Upstash-Timestamp）', async () => {
      const body = 'test-body';
      // 模拟一个 JWT 格式的签名（包含两个点）
      const jwtSignature = 'header.payload.signature';

      const request = {
        headers: new Map([
          ['Upstash-Signature', jwtSignature],
          // 注意：没有 Upstash-Timestamp
        ]),
        text: jest.fn().mockResolvedValue(body),
        url: 'https://test.url',
      };

      mockVerify.mockResolvedValue(body);

      const result = await verifyQStashSignature(request, mockEnv);
      
      expect(mockVerify).toHaveBeenCalledWith({
        signature: jwtSignature,
        body,
        url: 'https://test.url',
      });
      expect(new TextDecoder().decode(result)).toBe(body);
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
      expect(result).toHaveLength(2);
      expect(result.map(i => i.id).sort()).toEqual(['1', '3']);
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
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');
      const originalBody = 'test-body';

      const mockResponse = createMockResponse(200);
      global.fetch.mockResolvedValue(mockResponse);

      const result = await forwardToInstance(instance, normalizedUrl, request, originalBody);
      expect(result).toBe(mockResponse);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://instance1.com/webhook',
          method: 'POST',
        })
      );
    });

    it('应该在5xx错误时返回响应', async () => {
      const instance = { id: '1', url: 'https://instance1.com' };
      const request = {
        url: 'https://lb.example.com/webhook',
        method: 'POST',
        headers: new Map(),
      };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');
      const originalBody = 'test-body';

      const mockResponse = createMockResponse(500);
      global.fetch.mockResolvedValue(mockResponse);

      const result = await forwardToInstance(instance, normalizedUrl, request, originalBody);
      expect(result).toBe(mockResponse);
    });
  });

  describe('fetchWithRetry', () => {
    it('应该在第一个实例成功时返回响应', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const mockResponse = createMockResponse(200);
      global.fetch.mockResolvedValue(mockResponse);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      expect(result).toBe(mockResponse);
    });

    it('应该在第一个失败时尝试下一个实例', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response500 = createMockResponse(500);
      const response200 = createMockResponse(200);
      global.fetch.mockResolvedValueOnce(response500);
      global.fetch.mockResolvedValueOnce(response200);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      expect(result).toBe(response200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('应该在所有实例失败时返回最后一个5xx响应', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const lastResponse = createMockResponse(500);
      global.fetch.mockResolvedValue(lastResponse);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      expect(result).toBe(lastResponse);
    });

    it('应该在第一个实例返回500，第二个实例返回200时，取消第一个响应的body', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response500 = createMockResponse(500);
      const response200 = createMockResponse(200);
      
      global.fetch.mockResolvedValueOnce(response500);
      global.fetch.mockResolvedValueOnce(response200);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      expect(result).toBe(response200);
      expect(response500.body.cancel).toHaveBeenCalled();
      expect(response200.body.cancel).not.toHaveBeenCalled();
    });

    it('应该在多个5xx响应时，取消之前保存的5xx响应body', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
        { id: '3', url: 'https://instance3.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response500_1 = createMockResponse(500);
      const response500_2 = createMockResponse(500);
      const response200 = createMockResponse(200);
      
      global.fetch.mockResolvedValueOnce(response500_1);
      global.fetch.mockResolvedValueOnce(response500_2);
      global.fetch.mockResolvedValueOnce(response200);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      expect(result).toBe(response200);
      expect(response500_1.body.cancel).toHaveBeenCalled();
      expect(response500_2.body.cancel).toHaveBeenCalled();
      expect(response200.body.cancel).not.toHaveBeenCalled();
    });

    it('应该在所有实例返回5xx时，只取消前N-1个响应的body', async () => {
      const instances = [
        { id: '1', url: 'https://instance1.com' },
        { id: '2', url: 'https://instance2.com' },
      ];
      const request = { url: 'https://lb.example.com/webhook', method: 'POST', headers: new Map(), body: 'body' };
      const normalizedUrl = new URL(request.url);
      normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+/g, '/');

      const response500_1 = createMockResponse(500);
      const response500_2 = createMockResponse(500);
      
      // Mock fetch to return different responses for each call
      global.fetch.mockResolvedValueOnce(response500_1);
      global.fetch.mockResolvedValueOnce(response500_2);

      const result = await fetchWithRetry(instances, normalizedUrl, request, mockEnv, request.body);
      
      // Should return the last 5xx response
      expect(result.status).toBe(500);
      // First response should be cancelled
      expect(response500_1.body.cancel).toHaveBeenCalled();
      // Last response should not be cancelled (it's returned)
      expect(response500_2.body.cancel).not.toHaveBeenCalled();
    });
  });

  describe('upstash_get body cancellation', () => {
    it('应该在返回404时取消response body', async () => {
      // Mock fetch to return 404 response with body.cancel
      const mockResponse = createMockResponse(404);
      global.fetch.mockResolvedValue(mockResponse);
      
      const result = await upstash_get(mockEnv, 'non-existent-key');
      
      expect(result).toBeNull();
      expect(mockResponse.body.cancel).toHaveBeenCalled();
    });

    it('应该在返回其他错误时正常抛出异常', async () => {
      const mockResponse = createMockResponse(500);
      mockResponse.statusText = 'Internal Server Error';
      mockResponse.text = jest.fn().mockResolvedValue('Internal Server Error');
      global.fetch.mockResolvedValue(mockResponse);
      
      await expect(upstash_get(mockEnv, 'test-key')).rejects.toThrow('Upstash Get Error: 500 Internal Server Error');
      // 500错误不应该调用cancel，因为我们会读取response body
      expect(mockResponse.body.cancel).not.toHaveBeenCalled();
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
      it('应该在配额错误时立即返回true', () => {
        const error = new Error('free usage limit exceeded');
        const env = { UPSTASH_REDIS_REST_URL: 'test', UPSTASH_REDIS_REST_TOKEN: 'test' };

        expect(shouldFailover(error, env)).toBe(true);
      });

      it('应该在网络错误时立即返回true', () => {
        const error = new Error('fetch failed');
        const env = { UPSTASH_REDIS_REST_URL: 'test', UPSTASH_REDIS_REST_TOKEN: 'test' };

        expect(shouldFailover(error, env)).toBe(true);
      });

      it('应该在其他错误连续失败 3 次后返回true', () => {
        const error = new Error('unknown error');
        const env = { UPSTASH_REDIS_REST_URL: 'test', UPSTASH_REDIS_REST_TOKEN: 'test' };

        expect(shouldFailover(error, env)).toBe(false);
        expect(shouldFailover(error, env)).toBe(false);
        expect(shouldFailover(error, env)).toBe(true);
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
        const mockUpstashResponse = createMockResponse(200, {
          json: () => Promise.resolve({ result: 'upstash-value' }),
          text: () => Promise.resolve(JSON.stringify({ result: 'upstash-value' }))
        });
        global.fetch = jest.fn().mockResolvedValue(mockUpstashResponse);

        // Mock KV failure (quota error triggers immediate failover)
        mockKV.get.mockRejectedValue(new Error('free usage limit exceeded'));

        // 调用一次即触发故障转移并重试成功
        const result = await executeWithFailover('_kv_get', mockEnv, {}, 'test-key');
        
        expect(result).toBe('upstash-value');
        expect(getCurrentProvider()).toBe('Upstash Redis');
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
    it('应该在集成测试中正确转发请求', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      mockVerify.mockResolvedValue('body');

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
      const mockResponse = createMockResponse(200, { headers: new Map() });
      global.fetch.mockResolvedValue(mockResponse);

      const request = {
        url: 'https://lb.example.com/webhook',
        method: 'POST',
        headers: new Map([
          ['Upstash-Signature', 'v1a=ZXhwZWN0ZWQtc2lnbmF0dXJl'],
          ['Upstash-Timestamp', timestamp],
        ]),
        text: jest.fn().mockResolvedValue('body'),
        arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
      };

      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(200);
    });

    it('应该在无活跃实例时返回503', async () => {
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
    });

    it('应该在签名验证失败时返回401', async () => {
      const request = {
        url: 'https://lb.example.com/webhook',
        headers: new Map(),
        text: jest.fn().mockResolvedValue('body'),
        arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array()),
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
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const downloadBody = JSON.stringify({
        id: "task_123456789",
        chatId: "chat_987654321",
        msgId: 123456789,
        type: "download"
      });

      mockVerify.mockResolvedValue(downloadBody);

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
      const mockResponse = createMockResponse(200, { headers: new Map() });
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
          ['Upstash-Timestamp', timestamp],
        ]),
        text: jest.fn().mockResolvedValue(downloadBody),
        arrayBuffer: jest.fn().mockResolvedValue(new TextEncoder().encode(downloadBody)),
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