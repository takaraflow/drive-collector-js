/**
 * DropboxProvider Test
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mocks must come before imports
vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })
    }
}));

vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
    }
}));

import { DropboxProvider } from '../../../src/services/drives/DropboxProvider.js';

describe('DropboxProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new DropboxProvider();
    });

    test('should have correct type', () => {
        expect(provider.type).toBe('dropbox');
    });

    test('should be marked as advanced because it requires exported rclone token', () => {
        expect(provider.getInfo()).toMatchObject({
            type: 'dropbox',
            supportLevel: 'advanced'
        });
    });

    test('should handle valid token input', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const token = JSON.stringify({ access_token: "abc" });
        const result = await provider.handleInput('WAIT_TOKEN', token, {});
        
        expect(result.success).toBe(true);
        expect(result.data.token).toBe(token);
    });

    test('should accept opaque rclone token strings', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const result = await provider.handleInput('WAIT_TOKEN', 'sl.BC-token', {});

        expect(result.success).toBe(true);
        expect(result.data.token).toBe('sl.BC-token');
        expect(CloudTool.validateConfig).toHaveBeenCalledWith('dropbox', { token: 'sl.BC-token' });
    });

    test('should reject invalid token input', async () => {
        await expect(provider.handleInput('WAIT_TOKEN', '   ', {}))
            .resolves.toMatchObject({ success: false });
        await expect(provider.handleInput('WAIT_TOKEN', '{"foo":"bar"}', {}))
            .resolves.toMatchObject({ success: false });
    });

    test('should generate connection string', () => {
        const conn = provider.getConnectionString({ token: '{"a":1}' });
        expect(conn).toBe(':dropbox,token="{\\"a\\":1}":');
    });
});
