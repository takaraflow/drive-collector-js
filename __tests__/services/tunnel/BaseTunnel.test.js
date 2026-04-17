import { describe, test, expect, beforeEach } from 'vitest';
import { BaseTunnel } from '../../../src/services/tunnel/BaseTunnel.js';

// Create a concrete implementation for testing since BaseTunnel has abstract methods
class TestTunnel extends BaseTunnel {
    constructor(config) {
        super(config);
    }
}

describe('BaseTunnel', () => {
    let tunnel;
    const mockConfig = {
        enabled: true,
        port: 8080
    };

    beforeEach(() => {
        tunnel = new TestTunnel(mockConfig);
    });

    test('should initialize with config and default values', () => {
        expect(tunnel.config).toEqual(mockConfig);
        expect(tunnel.currentUrl).toBeNull();
        expect(tunnel.isReady).toBe(false);
    });

    test('should throw Error when initialize is called directly', async () => {
        const baseTunnel = new BaseTunnel(mockConfig);
        await expect(baseTunnel.initialize()).rejects.toThrow('Not implemented');
    });

    test('should return currentUrl when getPublicUrl is called', async () => {
        expect(await tunnel.getPublicUrl()).toBeNull();

        tunnel.currentUrl = 'https://example.com';
        expect(await tunnel.getPublicUrl()).toBe('https://example.com');
    });

    test('should return status object with correct properties', () => {
        const initialStatus = tunnel.getStatus();
        expect(initialStatus).toEqual({
            ready: false,
            url: null,
            provider: 'TestTunnel'
        });

        tunnel.isReady = true;
        tunnel.currentUrl = 'https://example.com';

        const updatedStatus = tunnel.getStatus();
        expect(updatedStatus).toEqual({
            ready: true,
            url: 'https://example.com',
            provider: 'TestTunnel'
        });
    });
});
