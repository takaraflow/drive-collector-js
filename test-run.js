import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../src/services/logger/index.js';
import { safeLogError, withErrorHandling } from '../../src/utils/errorHandler.js';

const mockLogError = vi.fn();

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        withModule: vi.fn().mockReturnValue({
            error: mockLogError
        })
    }
}));

describe('test', () => {
    test('mock test', () => {
        const error = new Error('Test error');
        safeLogError('Test context', error);
        expect(mockLogError).toHaveBeenCalled();
    });
});
