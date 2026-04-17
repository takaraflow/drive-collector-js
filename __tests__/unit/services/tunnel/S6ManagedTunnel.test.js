import fs from 'fs/promises';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { S6ManagedTunnel } from '../../../../src/services/tunnel/S6ManagedTunnel.js';

vi.mock('fs/promises');

describe('S6ManagedTunnel', () => {
    let tunnel;

    beforeEach(() => {
        vi.clearAllMocks();
        tunnel = new S6ManagedTunnel({ servicePath: '/test/path' });
    });

    describe('constructor', () => {
        test('should use provided servicePath', () => {
            expect(tunnel.servicePath).toBe('/test/path');
        });

        test('should fallback to default servicePath if not provided', () => {
            const defaultTunnel = new S6ManagedTunnel({});
            expect(defaultTunnel.servicePath).toBe('/run/service/cloudflared');
        });
    });

    describe('isServiceUp', () => {
        test('should return true if fs.access succeeds', async () => {
            fs.access.mockResolvedValueOnce(undefined);
            const result = await tunnel.isServiceUp();
            expect(result).toBe(true);
            expect(fs.access).toHaveBeenCalledWith('/test/path');
        });

        test('should return false if fs.access throws', async () => {
            fs.access.mockRejectedValueOnce(new Error('ENOENT'));
            const result = await tunnel.isServiceUp();
            expect(result).toBe(false);
            expect(fs.access).toHaveBeenCalledWith('/test/path');
        });
    });

    describe('waitForService', () => {
        test('should return true immediately if service is up', async () => {
            vi.spyOn(tunnel, 'isServiceUp').mockResolvedValueOnce(true);
            const result = await tunnel.waitForService(1000);
            expect(result).toBe(true);
            expect(tunnel.isServiceUp).toHaveBeenCalledTimes(1);
        });

        test('should return true if service comes up within timeout', async () => {
            vi.spyOn(tunnel, 'isServiceUp')
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);

            const start = Date.now();
            const result = await tunnel.waitForService(2000);
            const elapsed = Date.now() - start;

            expect(result).toBe(true);
            expect(tunnel.isServiceUp).toHaveBeenCalledTimes(2);
            expect(elapsed).toBeGreaterThanOrEqual(400); // at least one 500ms wait
        });

        test('should return false if service does not come up within timeout', async () => {
            vi.spyOn(tunnel, 'isServiceUp').mockResolvedValue(false);

            const start = Date.now();
            const result = await tunnel.waitForService(1200); // Timeout slightly larger than 2 intervals (1000ms)
            const elapsed = Date.now() - start;

            expect(result).toBe(false);
            expect(tunnel.isServiceUp).toHaveBeenCalled();
            expect(elapsed).toBeGreaterThanOrEqual(1000);
        });
    });
});
