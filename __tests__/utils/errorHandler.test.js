import { describe, test, expect, vi } from 'vitest';
import { safeLogError, withErrorHandling } from '../../src/utils/errorHandler.js';

describe('ErrorHandler Utility', () => {
    describe('safeLogError', () => {
        test('should handle basic error logging', () => {
            const error = new Error('Test error');
            expect(() => safeLogError('Test context', error)).not.toThrow();
        });

        test('should handle null error', () => {
            expect(() => safeLogError('Test context', null)).not.toThrow();
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
        });

        test('should rethrow error when rethrow is true', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('Failed'));
            const wrapped = withErrorHandling(fn, {
                context: 'Test',
                rethrow: true
            });

            await expect(wrapped()).rejects.toThrow('Failed');
        });
    });
});