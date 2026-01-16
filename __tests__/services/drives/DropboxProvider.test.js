/**
 * DropboxProvider Test
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DropboxProvider } from '../../../src/services/drives/DropboxProvider.js';

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

describe('DropboxProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new DropboxProvider();
    });

    test('should have correct type', () => {
        expect(provider.type).toBe('dropbox');
    });

    test('should handle valid token input', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const token = JSON.stringify({ access_token: "abc" });
        const result = await provider.handleInput('WAIT_TOKEN', token, {});
        
        expect(result.success).toBe(true);
        expect(result.data.token).toBe(token);
    });

    test('should generate connection string', () => {
        const conn = provider.getConnectionString({ token: '{"a":1}' });
        expect(conn).toBe(':dropbox,token="{\\"a\\":1}":');
    });
});
