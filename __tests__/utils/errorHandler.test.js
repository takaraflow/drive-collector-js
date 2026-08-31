import { describe, test, expect, vi } from 'vitest';
import { safeLogError, withErrorHandling } from '../../src/utils/errorHandler.js';
import { logger } from '../../src/services/logger/index.js';

vi.mock('../../src/services/logger/index.js', () => {
    const mockError = vi.fn();
    return {
        logger: {
            withModule: vi.fn(() => ({ error: mockError }))
        }
    };
});

describe('ErrorHandler Utility', () => {
    describe('safeLogError', () => {
        test('should handle basic error logging', () => {
            const error = new Error('Test error');
            safeLogError('Test context', error);
            expect(logger.withModule().error).toHaveBeenCalledWith('Test context', expect.objectContaining({
                error: 'Test error',
                stack: expect.any(String)
            }));
        });

        test('should handle null error', () => {
            safeLogError('Test context', null);
            expect(logger.withModule().error).toHaveBeenCalledWith('Test context', expect.objectContaining({
                error: 'Unknown error'
            }));
        });

        test('should fallback to console.error if logger fails', () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            logger.withModule().error.mockImplementationOnce(() => {
                throw new Error('Logger failed');
            });

            const error = new Error('Test error');
            safeLogError('Test context', error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                '[Test context]',
                expect.objectContaining({
                    error: 'Test error',
                    logError: 'Logger failed'
                })
            );

            consoleErrorSpy.mockRestore();
        });
    });

    describe('withErrorHandling', () => {
        test('should return function result on success', async () => {
            const fn = vi.fn().mockResolvedValue('success');
            const wrapped = withErrorHandling(fn, { context: 'Test' });

            const result = await wrapped('arg1', 'arg2');
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
        });

        test('should return default value on error', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('Failed'));
            const wrapped = withErrorHandling(fn, {
                context: 'Test',
                defaultValue: 'default'
            });

            const result = await wrapped();
            expect(result).toBe('default');
            expect(logger.withModule().error).toHaveBeenCalledWith('Test failed', expect.objectContaining({
                error: 'Failed'
            }));
        });

        test('should rethrow error when rethrow is true', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('Failed'));
            const wrapped = withErrorHandling(fn, {
                context: 'Test',
                rethrow: true
            });

            await expect(wrapped()).rejects.toThrow('Failed');
            expect(logger.withModule().error).toHaveBeenCalledWith('Test failed', expect.objectContaining({
                error: 'Failed'
            }));
        });
    });
});
