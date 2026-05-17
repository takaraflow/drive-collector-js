/**
 * BoxProvider Test
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

import { BoxProvider } from '../../../src/services/drives/BoxProvider.js';

describe('BoxProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new BoxProvider();
    });

    test('should validate token', () => {
        const result = provider._validateToken('{"access_token":"abc"}');
        expect(result.valid).toBe(true);
    });

    test('should validate with lsf because box does not support about', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        await provider.validateConfig({ token: '{"access_token":"abc"}' });

        expect(CloudTool.validateConfig).toHaveBeenCalledWith('box', expect.anything(), 'lsf');
    });

    test('should be marked as advanced because it requires exported rclone token', () => {
        expect(provider.getInfo()).toMatchObject({
            type: 'box',
            supportLevel: 'advanced'
        });
    });

    test('should generate connection string', () => {
        const conn = provider.getConnectionString({ token: '{"a":1}' });
        expect(conn).toBe(':box,token="{\\"a\\":1}":');
    });
});
