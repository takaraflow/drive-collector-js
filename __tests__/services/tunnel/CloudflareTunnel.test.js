import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareTunnel } from '../../../src/services/tunnel/CloudflareTunnel.js';
import fs from 'fs/promises';

vi.mock('fs/promises');
vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })
    }
}));

describe('CloudflareTunnel', () => {
    let tunnel;
    const mockConfig = {
        enabled: true,
        metricsPort: 2000,
        metricsHost: '127.0.0.1',
        servicePath: '/run/service/cloudflared'
    };

    beforeEach(() => {
        vi.resetAllMocks();
        tunnel = new CloudflareTunnel(mockConfig);
        // Mock global fetch
        global.fetch = vi.fn();
    });

    afterEach(() => {
        tunnel.stop();
    });

    test('should extract URL from metrics correctly', async () => {
        const metrics = `
# HELP cloudflared_tunnel_user_hostname The user-provided hostname of the tunnel.
# TYPE cloudflared_tunnel_user_hostname gauge
cloudflared_tunnel_user_hostname{user_hostname="tender-sand-123.trycloudflare.com"} 1
`;
        const url = await tunnel.extractUrl(metrics);
        expect(url).toBe('https://tender-sand-123.trycloudflare.com');
    });

    test('should return null if URL not found in metrics', async () => {
        const metrics = 'some random string';
        const url = await tunnel.extractUrl(metrics);
        expect(url).toBeNull();
    });

    test('should check if service is up', async () => {
        fs.access.mockResolvedValueOnce(undefined);
        const up = await tunnel.isServiceUp();
        expect(up).toBe(true);
        expect(fs.access).toHaveBeenCalledWith(mockConfig.servicePath);
    });

    test('should return false if service is down', async () => {
        fs.access.mockRejectedValueOnce(new Error('not found'));
        const up = await tunnel.isServiceUp();
        expect(up).toBe(false);
    });

    test('should fetch metrics successfully', async () => {
        const mockMetrics = 'cloudflared_tunnel_user_hostname{user_hostname="test.com"} 1';
        global.fetch.mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve(mockMetrics)
        });

        const metrics = await tunnel._fetchMetrics();
        expect(metrics).toBe(mockMetrics);
    });

    test('should handle fetch errors gracefully', async () => {
        global.fetch.mockRejectedValueOnce(new Error('network error'));
        const metrics = await tunnel._fetchMetrics();
        expect(metrics).toBeNull();
    });
});