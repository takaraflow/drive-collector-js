import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock KV
const mockKV = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(true)
};
jest.unstable_mockModule('../../src/services/kv.js', () => ({
    kv: mockKV
}));

// Mock logger
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.unstable_mockModule('../../src/services/logger.js', () => ({
    default: mockLogger
}));

// Import after mocking
const { handle429Error } = await import('../../src/utils/limiter.js');

describe('Limiter 429 & FloodWait Handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockKV.get.mockResolvedValue(null);
    });

    it('should handle 429 errors with retry', async () => {
        let callCount = 0;
        const mockTask = jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                const err = new Error('FloodWait');
                err.code = 429;
                throw err;
            }
            return 'success';
        });

        // Use fake timers
        jest.useFakeTimers();
        
        const promise = handle429Error(mockTask, 10);
        
        // Advance time for retry
        await jest.advanceTimersByTimeAsync(5000);
        
        const result = await promise;
        expect(result).toBe('success');
        expect(callCount).toBe(2);
        
        jest.useRealTimers();
    });
});