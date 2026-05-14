import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareTunnel } from '../../../src/services/tunnel/CloudflareTunnel.js';
import { EventEmitter } from 'events';
import fs from 'fs/promises';

vi.mock('fs/promises');
const execFileAsyncMock = vi.fn();
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
    execFile: (...args) => execFileAsyncMock(...args),
    spawn: (...args) => spawnMock(...args)
}));
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

    test('should start standalone cloudflared when s6-svc is unavailable', async () => {
        fs.access.mockRejectedValueOnce(Object.assign(new Error('missing s6-svc'), { code: 'ENOENT' }));

        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const proc = new EventEmitter();
        proc.stdout = stdout;
        proc.stderr = stderr;
        proc.kill = vi.fn();
        spawnMock.mockReturnValueOnce(proc);

        await tunnel.initialize();

        expect(spawnMock).toHaveBeenCalledWith(
            'cloudflared',
            [
                'tunnel',
                '--url',
                'http://127.0.0.1:7860',
                '--metrics',
                '127.0.0.1:2000',
                '--no-autoupdate'
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        stdout.emit('data', Buffer.from('Visit it: https://demo.trycloudflare.com\n'));
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(tunnel.currentUrl).toBe('https://demo.trycloudflare.com');
        expect(tunnel.isReady).toBe(true);
    });
});
