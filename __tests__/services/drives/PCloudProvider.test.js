/**
 * PCloudProvider Test
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })
    }
}));

vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
        _obscure: vi.fn(p => `obs_${p}`)
    }
}));

import { PCloudProvider } from '../../../src/services/drives/PCloudProvider.js';

describe('PCloudProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new PCloudProvider();
    });

    test('should be marked as advanced because pCloud requires exported rclone token', () => {
        expect(provider.getInfo()).toMatchObject({
            type: 'pcloud',
            supportLevel: 'advanced'
        });
    });

    test('should require an oauth access token and hostname step', () => {
        const steps = provider.getBindingSteps();
        expect(steps).toHaveLength(2);
        expect(steps[0].step).toBe('WAIT_TOKEN');
        expect(steps[1].step).toBe('WAIT_HOSTNAME');
        expect(provider._validateToken(JSON.stringify({ access_token: 'a' })).valid).toBe(true);
        expect(provider._validateToken(JSON.stringify({ refresh_token: 'r' })).valid).toBe(false);
    });

    test('should validate only after token and hostname are collected', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const token = JSON.stringify({ access_token: 'a' });
        const tokenResult = await provider.handleInput('WAIT_TOKEN', token, {});

        expect(tokenResult.success).toBe(true);
        expect(tokenResult.nextStep).toBe('WAIT_HOSTNAME');
        expect(CloudTool.validateConfig).not.toHaveBeenCalled();

        const result = await provider.handleInput('WAIT_HOSTNAME', 'eapi.pcloud.com', {
            data: tokenResult.data
        });
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ token, hostname: 'eapi.pcloud.com' });
        expect(CloudTool.validateConfig).toHaveBeenCalledWith('pcloud', result.data);
    });

    test('should default hostname when input is blank', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const result = await provider.handleInput('WAIT_HOSTNAME', '  ', {
            data: { token: JSON.stringify({ access_token: 'a' }) }
        });

        expect(result.success).toBe(true);
        expect(result.data.hostname).toBe('api.pcloud.com');
    });

    test('should reject invalid hostname values', async () => {
        await expect(provider.handleInput('WAIT_HOSTNAME', 'https://api.pcloud.com', {
            data: { token: JSON.stringify({ access_token: 'a' }) }
        })).resolves.toMatchObject({ success: false });
    });

    test('should generate connection string using oauth token and hostname', () => {
        const conn = provider.getConnectionString({ token: '{"a":1}', hostname: 'eapi.pcloud.com' });
        expect(conn).toBe(':pcloud,token="{\\"a\\":1}",hostname="eapi.pcloud.com":');
    });
});
