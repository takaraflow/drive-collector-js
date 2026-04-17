import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import CloudSecretsProvider from '../../../src/services/secrets/CloudSecretsProvider.js';

class MockCloudSecretsProvider extends CloudSecretsProvider {
    constructor(options = {}) {
        super(options);
        this.fetchSecretsMock = vi.fn();
    }

    async fetchSecrets() {
        return this.fetchSecretsMock();
    }
}

describe('CloudSecretsProvider', () => {
    let provider;

    beforeEach(() => {
        vi.useFakeTimers();
        provider = new MockCloudSecretsProvider();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllTimers();
    });

    describe('initialization', () => {
        it('should initialize with correct default values', () => {
            const defaultProvider = new MockCloudSecretsProvider();
            expect(defaultProvider.options).toEqual({});
            expect(defaultProvider.currentSecrets).toEqual({});
            expect(defaultProvider.lastVersion).toBeNull();
            expect(defaultProvider.isPolling).toBe(false);
        });

        it('should initialize with provided options', () => {
            const options = { testOption: 'testValue' };
            const customProvider = new MockCloudSecretsProvider(options);
            expect(customProvider.options).toEqual(options);
        });
    });

    describe('startPolling', () => {
        it('should set isPolling to true and create an interval', () => {
            expect(provider.isPolling).toBe(false);
            provider.startPolling(1000);
            expect(provider.isPolling).toBe(true);
            expect(provider.pollInterval).not.toBeNull();
        });

        it('should ignore duplicate startPolling calls', () => {
            provider.startPolling(1000);
            const initialInterval = provider.pollInterval;

            // Second call
            provider.startPolling(1000);
            expect(provider.pollInterval).toBe(initialInterval);
        });

        it('should start polling with default interval of 60000ms', async () => {
            provider.fetchSecretsMock.mockResolvedValue({});
            provider.startPolling();
            expect(provider.isPolling).toBe(true);

            await vi.advanceTimersByTimeAsync(59999);
            expect(provider.fetchSecretsMock).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(provider.fetchSecretsMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('polling execution and change detection', () => {
        it('should call fetchSecrets at expected intervals', async () => {
            provider.fetchSecretsMock.mockResolvedValue({});
            provider.startPolling(1000);

            await vi.advanceTimersByTimeAsync(1000);
            expect(provider.fetchSecretsMock).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(2000);
            expect(provider.fetchSecretsMock).toHaveBeenCalledTimes(3);
        });

        it('should trigger detectChanges on successful fetch', async () => {
            const newSecrets = { KEY: 'VALUE' };
            provider.fetchSecretsMock.mockResolvedValue(newSecrets);
            const detectChangesSpy = vi.spyOn(provider, 'detectChanges');

            provider.startPolling(1000);
            await vi.advanceTimersByTimeAsync(1000);

            expect(detectChangesSpy).toHaveBeenCalledWith(newSecrets);
        });

        it('should emit configChanged when changes are detected during polling', async () => {
            const newSecrets = { KEY: 'NEW_VALUE' };
            provider.fetchSecretsMock.mockResolvedValue(newSecrets);
            const configChangedHandler = vi.fn();
            provider.on('configChanged', configChangedHandler);

            provider.startPolling(1000);
            await vi.advanceTimersByTimeAsync(1000);

            expect(configChangedHandler).toHaveBeenCalledTimes(1);
            expect(configChangedHandler).toHaveBeenCalledWith([
                { key: 'KEY', oldValue: undefined, newValue: 'NEW_VALUE' }
            ]);
            expect(provider.getCurrentSecrets()).toEqual(newSecrets);
        });

        it('should not process fetch if polling is stopped concurrently', async () => {
            provider.fetchSecretsMock.mockResolvedValue({});

            provider.startPolling(1000);
            provider.stopPolling();

            await vi.advanceTimersByTimeAsync(1000);

            expect(provider.fetchSecretsMock).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('should call onError and emit error event when fetchSecrets fails', async () => {
            const error = new Error('Fetch failed');
            provider.fetchSecretsMock.mockRejectedValue(error);
            const errorHandler = vi.fn();
            provider.on('error', errorHandler);
            const onErrorSpy = vi.spyOn(provider, 'onError');

            provider.startPolling(1000);
            await vi.advanceTimersByTimeAsync(1000);

            expect(onErrorSpy).toHaveBeenCalledWith(error);
            expect(errorHandler).toHaveBeenCalledWith(error);
            expect(errorHandler).toHaveBeenCalledTimes(1);
        });
    });
});
