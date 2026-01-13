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
    success: vi.fn(),
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
      vi.resetAllMocks();
    });

    it('should fetch instances concurrently', async () => {
      let releaseGate;
      const gate = new Promise(resolve => {
        releaseGate = resolve;
      });
      let startedGets = 0;

      // Mock executeWithFailover to simulate latency
      executeWithFailover.mockImplementation(async (op, env, ctx, log, arg) => {
        if (op === '_kv_list') {
            if (arg === 'instance:') {
                return { keys: [{ name: 'instance:1' }, { name: 'instance:2' }, { name: 'instance:3' }] };
            }
            return { keys: [] };
        }
        if (op === '_kv_get') {
          startedGets += 1;
          await gate;
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

      const instancesPromise = getActiveInstances(env, ctx, log);

      for (let i = 0; i < 10 && startedGets < 3; i += 1) {
        await Promise.resolve();
      }

      const startedSnapshot = startedGets;
      releaseGate();

      const instances = await instancesPromise;

      expect(instances).toHaveLength(3);
      
      // Verify executeWithFailover was called correctly
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_list', env, ctx, expect.anything(), 'instance:');
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_get', env, ctx, expect.anything(), 'instance:1');
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_get', env, ctx, expect.anything(), 'instance:2');
      expect(executeWithFailover).toHaveBeenCalledWith('_kv_get', env, ctx, expect.anything(), 'instance:3');

      expect(startedSnapshot).toBe(3);
    });
  });
});
