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

    test('should generate connection string using username/password', () => {
        const conn = provider.getConnectionString({ user: 'u', pass: 'p' });
        expect(conn).toBe(':pcloud,username="u",password="p":');
    });
});
