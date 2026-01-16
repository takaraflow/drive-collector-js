/**
 * OSSProvider Test
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { OSSProvider } from '../../../src/services/drives/OSSProvider.js';

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

describe('OSSProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OSSProvider();
    });

    test('should have correct type', () => {
        expect(provider.type).toBe('oss');
    });

    test('should return correct binding steps', () => {
        const steps = provider.getBindingSteps();
        expect(steps).toHaveLength(3);
        expect(steps[0].step).toBe('WAIT_ENDPOINT');
    });

    test('should use lsd for validation', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        await provider.validateConfig({ endpoint: 'e', ak: 'a', sk: 's' });
        
        expect(CloudTool.validateConfig).toHaveBeenCalledWith('oss', expect.anything(), 'lsd');
    });

    test('should generate s3 connection string', () => {
        const conn = provider.getConnectionString({ endpoint: 'e', ak: 'a', sk: 's' });
        expect(conn).toContain(':s3,provider="Alibaba"');
        expect(conn).toContain('endpoint="e"');
        expect(conn).toContain('access_key_id="a"');
        expect(conn).toContain('secret_access_key="s"');
    });
});
