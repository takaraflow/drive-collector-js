/**
 * WebDAVProvider Test
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
        normalizePasswordForRclone: vi.fn(p => `obs_${p}`),
        _obscure: vi.fn(p => `obs_${p}`)
    }
}));

import { WebDAVProvider } from '../../../src/services/drives/WebDAVProvider.js';

describe('WebDAVProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new WebDAVProvider();
    });

    test('should validate URL', async () => {
        const result = await provider.handleInput('WAIT_URL', 'invalid', {});
        expect(result.success).toBe(false);
        
        const valid = await provider.handleInput('WAIT_URL', 'https://dav.com', {});
        expect(valid.success).toBe(true);
    });

    test('should obscure password before validating config', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const result = await provider.validateConfig({ url: 'https://dav.com', user: 'u', pass: 'plain' });

        expect(result.success).toBe(true);
        expect(CloudTool.normalizePasswordForRclone).toHaveBeenCalledWith('plain', { format: 'plain' });
        expect(CloudTool.validateConfig).toHaveBeenCalledWith('webdav', {
            url: 'https://dav.com',
            user: 'u',
            pass: 'obs_plain',
            pass_format: 'rclone_obscured',
            config_schema_version: 1
        });
    });

    test('should generate connection string', () => {
        const conn = provider.getConnectionString({ url: 'u', user: 'n', pass: 'p', pass_format: 'rclone_obscured' });
        expect(conn).toBe(':webdav,url="u",user="n",pass="p",vendor="other":');
    });

    test('should reject unnormalized password before building connection string', () => {
        expect(() => provider.getConnectionString({ url: 'u', user: 'n', pass: 'p', pass_format: 'plain' }))
            .toThrow('pass_format:rclone_obscured');
    });
});
