import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyQStashSignature } from '../src/auth/qstash.js';
import { Receiver } from '@upstash/qstash';

// Mock dependencies
vi.mock('@upstash/qstash', () => ({
  Receiver: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockResolvedValue(true)
  }))
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
    it('should use Promise.all for concurrent instance fetching', async () => {
      // This test verifies the fix by checking that the code uses Promise.all
      // We'll read the source to confirm the fix is in place
      
      const fs = require('fs');
      const path = require('path');
      const instanceManagerPath = path.join(__dirname, '../src/core/InstanceManager.js');
      const content = fs.readFileSync(instanceManagerPath, 'utf8');
      
      // Verify the fix: Promise.all should be used with map
      expect(content).toContain('Promise.all(');
      expect(content).toContain('.map(keyName =>');
      
      // Verify it's not using sequential approach
      expect(content).not.toMatch(/for\s*\(\s*const\s+keyName\s+of\s+instanceKeys\s*\)\s*\{[^}]*await\s+executeWithFailover/s);
    });
  });
});