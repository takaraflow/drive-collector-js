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

    test('should generate connection string', () => {
        const conn = provider.getConnectionString({ url: 'u', user: 'n', pass: 'p' });
        expect(conn).toBe(':webdav,url="u",user="n",pass="p",vendor="other":');
    });
});
