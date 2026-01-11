// Mock KV
const mockKV = {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(true)
};
vi.mock('../../src/services/CacheService.js', () => ({
    cache: mockKV
}));

// Mock logger
const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withModule: vi.fn().mockReturnThis(),
    withContext: vi.fn().mockReturnThis()
};
vi.mock('../../src/services/logger/index.js', () => ({
    default: mockLogger,
    logger: mockLogger
}));

// Import after mocking
const { handle429Error } = await import('../../src/utils/limiter.js');

describe('Limiter 429 & FloodWait Handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockKV.get.mockResolvedValue(null);
    });

    it('should handle 429 errors with retry', async () => {
        let callCount = 0;
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        const mockTask = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                const err = new Error('FloodWait');
                err.code = 429;
                err.retryAfter = 1;
                throw err;
            }
            return 'success';
        });

        // Use fake timers
        vi.useFakeTimers();
        
        const promise = handle429Error(mockTask, 10);
        
        // Advance time for retry
        await vi.advanceTimersByTimeAsync(1000);
        
        const result = await promise;
        expect(result).toBe('success');
        expect(callCount).toBe(2);
        
        vi.useRealTimers();
        randomSpy.mockRestore();
    });
});
