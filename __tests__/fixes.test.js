import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyQStashSignature } from '../src/auth/qstash.js';
import { getActiveInstances } from '../src/core/InstanceManager.js';
import { Receiver } from '@upstash/qstash';
import { executeWithFailover } from '../src/legacy/redisCompat.js';

// Mock依赖
vi.mock('@upstash/qstash', () => ({
  Receiver: vi.fn()
}));

vi.mock('../src/legacy/redisCompat.js', () => ({
  executeWithFailover: vi.fn()
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis()
  },
  isTestEnvironment: true
}));

import { logger as mockLogger } from '../src/logger.js';

describe('Fix Verification Tests', () => {
  
  describe('QStash Memory Safety Fix', () => {
    it('should consume request body directly without cloning', async () => {
      const mockVerify = vi.fn().mockResolvedValue(true);
      Receiver.mockImplementation(() => ({
        verify: mockVerify
      }));

      const requestBody = JSON.stringify({ message: 'test' });
      const request = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'Upstash-Signature': 'sig' },
        body: requestBody
      });

      // Spy on clone to ensure it's NOT called
      const cloneSpy = vi.spyOn(request, 'clone');

      const env = { 
        QSTASH_CURRENT_SIGNING_KEY: 'secret',
        QSTASH_URL: 'https://qstash.upstash.io' 
      };

      const result = await verifyQStashSignature(request, env);

      // Assert clone was NOT called
      expect(cloneSpy).not.toHaveBeenCalled();
      
      // Assert body was used
      expect(request.bodyUsed).toBe(true);
      
      // Assert result is Uint8Array (encoded body)
      expect(result).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(result)).toBe(requestBody);
    });
  });

  describe('InstanceManager Concurrency Fix', () => {
    beforeEach(() => {
      vi.useRealTimers(); // 使用真实定时器以测试并发
      vi.resetAllMocks();
    });

    it('should fetch instances concurrently', async () => {
      // Mock executeWithFailover to simulate latency
      executeWithFailover.mockImplementation(async (op, env, ctx, log, arg) => {
        if (op === '_kv_list') {
            if (arg === 'instance:') {
                return { keys: [{ name: 'instance:1' }, { name: 'instance:2' }, { name: 'instance:3' }] };
            }
            return { keys: [] };
        }
        if (op === '_kv_get') {
          // Simulate network delay
          await new Promise(resolve => setTimeout(resolve, 50)); 
          return JSON.stringify({ 
            id: arg, 
            status: 'active', 
            lastHeartbeat: Date.now(),
            url: `http://${arg}`
          });
        }
        return null;
      });

      const env = { KV_STORAGE: {} };
      const ctx = {};
      const log = mockLogger;

      const start = Date.now();
      const instances = await getActiveInstances(env, ctx, log);
      const duration = Date.now() - start;

      expect(instances).toHaveLength(3);
      
      // Verify executeWithFailover was called correctly
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_list', env, ctx, expect.anything(), 'instance:');
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_get', env, ctx, expect.anything(), 'instance:1');
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_get', env, ctx, expect.anything(), 'instance:2');
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_get', env, ctx, expect.anything(), 'instance:3');

      // 验证时间：如果是串行，应该是 50 * 3 = 150ms 以上
      // 如果是并发，应该是 50ms 左右
      // 考虑到 overhead，我们设置一个较宽的阈值
      console.log(`Duration: ${duration}ms`);
      // 注意：在某些极快的 CI 环境中，overhead 可能很小，但如果机器慢，overhead 可能大。
      // 只要远小于 150ms 即可。
      expect(duration).toBeLessThan(140);
    });
  });
});
