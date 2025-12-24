import { runBotTask, runMtprotoTask, fileLimiter, PRIORITY } from '../src/utils/limiter';

describe('Limiter Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('runBotTask', () => {
    test('executes function through global and user limiters', async () => {
      const mockFn = jest.fn().mockResolvedValue('result');

      const result = await runBotTask(mockFn, 123);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    test('handles user-specific limiting', async () => {
      const mockFn = jest.fn().mockResolvedValue('result');

      // First call for user 123
      await runBotTask(mockFn, 123);
      // Second call for same user should still work (basic test)
      await runBotTask(mockFn, 123);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    test('works without userId (global limiter only)', async () => {
      const mockFn = jest.fn().mockResolvedValue('result');

      const result = await runBotTask(mockFn);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });
  });

  describe('runMtprotoTask', () => {
    test('executes function through MTProto limiter', async () => {
      const mockFn = jest.fn().mockResolvedValue('result');

      const result = await runMtprotoTask(mockFn);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });
  });

  describe('fileLimiter', () => {
    test('limits concurrent file operations', async () => {
      const mockFn = jest.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10)));

      // Start multiple operations
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(fileLimiter.run(mockFn));
      }

      await Promise.all(promises);

      expect(mockFn).toHaveBeenCalledTimes(5);
    });
  });

  describe('PRIORITY', () => {
    test('defines priority levels', () => {
      expect(PRIORITY.HIGH).toBe(10);
      expect(PRIORITY.NORMAL).toBe(0);
      expect(PRIORITY.LOW).toBe(-10);
    });
  });
});