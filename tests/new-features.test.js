// 新功能测试 - 任务调度失败处理优化
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
import { describe, expect, it, beforeEach } from '@jest/globals';
import {
  fetchWithRetry,
  getActiveInstances,
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

describe('任务调度失败处理优化测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerify.mockReset();
    mockVerify.mockImplementation(async (options) => {
      return options.body;
    });
    global.__QSTASH_MOCK_VERIFY__ = mockVerify;
    global.fetch.mockReset();
  });

  describe('fetchWithRetry - 4xx 停止重试逻辑', () => {
    it('应该在实例返回400时立即停止重试并透传', async () => {
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

    it('应该在实例返回422时立即停止重试并透传', async () => {
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

    it('应该在实例返回401时立即停止重试并透传', async () => {
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

    it('应该在第一个实例500，第二个实例400时，取消500响应并返回400', async () => {
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

  describe('getActiveInstances - 无活跃实例处理', () => {
    it('应该在无活跃实例时返回空数组', async () => {
      mockKV.list.mockResolvedValue({ keys: [] });

      const result = await getActiveInstances(mockEnv, {});
      expect(result).toEqual([]);
    });

    it('应该在所有实例都过期时返回空数组', async () => {
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

      console.warn.mockClear();
      
      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(503);
      
      // 验证 console.warn 被调用并包含元数据
      expect(console.warn).toHaveBeenCalled();
      const warnCalls = console.warn.mock.calls;
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

      console.warn.mockClear();
      
      const lb = await import('../src/index.js');
      const response = await lb.default.fetch(request, mockEnv, {});

      expect(response.status).toBe(401);
      
      // 验证警告日志包含元数据
      const warnCalls = console.warn.mock.calls;
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