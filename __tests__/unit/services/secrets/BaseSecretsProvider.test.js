import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BaseSecretsProvider from '../../../../src/services/secrets/BaseSecretsProvider.js';

describe('BaseSecretsProvider', () => {
    let provider;

    beforeEach(() => {
        provider = new BaseSecretsProvider();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        provider.cleanup();
    });

    it('should initialize with correct default values', () => {
        expect(provider.pollInterval).toBeNull();
        expect(provider.isPolling).toBe(false);
    });

    it('should throw error when fetchSecrets is called directly', async () => {
        await expect(provider.fetchSecrets()).rejects.toThrow('fetchSecrets must be implemented by subclass');
    });

    it('should throw error when startPolling is called directly', () => {
        expect(() => provider.startPolling()).toThrow('startPolling must be implemented by subclass');
    });

    it('should clear interval and reset flags when stopPolling is called', () => {
        // Mock a pollInterval
        provider.pollInterval = setInterval(() => {}, 1000);
        provider.isPolling = true;

        provider.stopPolling();

        expect(provider.pollInterval).toBeNull();
        expect(provider.isPolling).toBe(false);
    });

    it('should emit configChanged event with changes when onConfigChange is called', () => {
        const emitSpy = vi.spyOn(provider, 'emit');
        const mockChanges = [{ key: 'API_KEY', oldValue: 'old', newValue: 'new' }];

        provider.onConfigChange(mockChanges);

        expect(emitSpy).toHaveBeenCalledWith('configChanged', mockChanges);
    });

    it('should emit error event when onError is called', () => {
        // Prevent uncaught exception from crashing the test run
        provider.on('error', () => {});

        const emitSpy = vi.spyOn(provider, 'emit');
        const mockError = new Error('Test error');

        provider.onError(mockError);

        expect(emitSpy).toHaveBeenCalledWith('error', mockError);
    });

    it('should call stopPolling and removeAllListeners when cleanup is called', () => {
        const stopPollingSpy = vi.spyOn(provider, 'stopPolling');
        const removeAllListenersSpy = vi.spyOn(provider, 'removeAllListeners');

        provider.cleanup();

        expect(stopPollingSpy).toHaveBeenCalled();
        expect(removeAllListenersSpy).toHaveBeenCalled();
    });
});
