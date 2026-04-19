import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseLogger } from '../../../src/services/logger/BaseLogger.js';

describe('BaseLogger', () => {
    it('should throw an error when instantiated directly', () => {
        expect(() => new BaseLogger()).toThrowError("BaseLogger is an abstract class and cannot be instantiated directly");
    });

    describe('when subclassed', () => {
        class DummyLogger extends BaseLogger {
            constructor(options) {
                super(options);
            }
        }

        let logger;

        beforeEach(() => {
            logger = new DummyLogger({ someOption: true });
        });

        it('should initialize successfully', async () => {
            expect(logger.isInitialized).toBe(false);
            await logger.initialize();
            expect(logger.isInitialized).toBe(true);
        });

        it('should connect and disconnect successfully', async () => {
            expect(logger.connected).toBe(false);
            await logger.connect();
            expect(logger.connected).toBe(true);

            // Connecting again should return early
            await logger.connect();
            expect(logger.connected).toBe(true);

            await logger.disconnect();
            expect(logger.connected).toBe(false);

            // Disconnecting again should return early
            await logger.disconnect();
            expect(logger.connected).toBe(false);
        });

        it('should call _connect and _disconnect if implemented', async () => {
            logger._connect = vi.fn().mockResolvedValue();
            logger._disconnect = vi.fn().mockResolvedValue();

            await logger.connect();
            expect(logger._connect).toHaveBeenCalledOnce();
            expect(logger.connected).toBe(true);

            await logger.disconnect();
            expect(logger._disconnect).toHaveBeenCalledOnce();
            expect(logger.connected).toBe(false);
        });

        it('should throw Not implemented for abstract logging methods', async () => {
            await expect(logger.info('test')).rejects.toThrow('Not implemented');
            await expect(logger.warn('test')).rejects.toThrow('Not implemented');
            await expect(logger.error('test')).rejects.toThrow('Not implemented');
            await expect(logger.debug('test')).rejects.toThrow('Not implemented');
        });

        it('should call _flush if implemented', async () => {
            logger._flush = vi.fn().mockResolvedValue('flushed');
            const result = await logger.flush(5000);
            expect(logger._flush).toHaveBeenCalledWith(5000);
            expect(result).toBe('flushed');
        });

        it('should not throw on flush if _flush is not implemented', async () => {
            const result = await logger.flush();
            expect(result).toBeUndefined();
        });

        it('should return correct provider name and connection info', () => {
            expect(logger.getProviderName()).toBe('DummyLogger');
            expect(logger.getConnectionInfo()).toEqual({
                provider: 'DummyLogger',
                connected: false
            });

            // Change connection state and check again
            logger.connected = true;
            expect(logger.getConnectionInfo()).toEqual({
                provider: 'DummyLogger',
                connected: true
            });
        });

        it('should cleanup resources on destroy', async () => {
            logger.disconnect = vi.fn().mockResolvedValue();
            await logger.destroy();
            expect(logger.disconnect).toHaveBeenCalledOnce();
        });
    });
});
