/**
 * OSSProvider Test
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

import { OSSProvider } from '../../../src/services/drives/OSSProvider.js';

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
        expect(steps).toHaveLength(4);
        expect(steps[0].step).toBe('WAIT_ENDPOINT');
        expect(steps[1].step).toBe('WAIT_BUCKET');
        expect(steps[2].step).toBe('WAIT_AK');
        expect(steps[3].step).toBe('WAIT_SK');
    });

    test('should collect bucket before credentials', async () => {
        const endpointResult = await provider.handleInput('WAIT_ENDPOINT', 'oss-cn-hangzhou.aliyuncs.com', {});
        expect(endpointResult.success).toBe(true);
        expect(endpointResult.nextStep).toBe('WAIT_BUCKET');
        expect(endpointResult.data.endpoint).toBe('oss-cn-hangzhou.aliyuncs.com');

        const bucketResult = await provider.handleInput('WAIT_BUCKET', 'my-bucket', { data: endpointResult.data });
        expect(bucketResult.success).toBe(true);
        expect(bucketResult.nextStep).toBe('WAIT_AK');
        expect(bucketResult.data.bucket).toBe('my-bucket');
    });

    test('should accept and normalize http origin endpoints', async () => {
        const result = await provider.handleInput('WAIT_ENDPOINT', 'https://s3.example.com/', {});

        expect(result.success).toBe(true);
        expect(result.data.endpoint).toBe('https://s3.example.com');
    });

    test('should reject endpoint with path, query, credentials, or unsupported protocol', async () => {
        await expect(provider.handleInput('WAIT_ENDPOINT', 'https://oss-cn-hangzhou.aliyuncs.com/path', {}))
            .resolves.toMatchObject({ success: false });
        await expect(provider.handleInput('WAIT_ENDPOINT', 'https://s3.example.com/?region=us', {}))
            .resolves.toMatchObject({ success: false });
        await expect(provider.handleInput('WAIT_ENDPOINT', 'https://user:pass@s3.example.com', {}))
            .resolves.toMatchObject({ success: false });
        await expect(provider.handleInput('WAIT_ENDPOINT', 'ftp://s3.example.com', {}))
            .resolves.toMatchObject({ success: false });
    });

    test('should reject invalid bucket names', async () => {
        await expect(provider.handleInput('WAIT_BUCKET', '../bucket', { data: { endpoint: 'e' } }))
            .resolves.toMatchObject({ success: false });
    });

    test('should use bucket-scoped lsf for validation', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        await provider.validateConfig({ endpoint: 'e', bucket: 'bucket', ak: 'a', sk: 's' });
        
        expect(CloudTool.validateConfig).toHaveBeenCalledWith('oss', expect.anything(), 'lsf');
        expect(CloudTool.normalizePasswordForRclone).not.toHaveBeenCalled();
    });

    test('should generate bucket-scoped s3 connection string', () => {
        const conn = provider.getConnectionString({ endpoint: 'e', bucket: 'bucket', ak: 'a', sk: 's' });
        expect(conn).toContain(':s3,');
        expect(conn).toContain('endpoint="e"');
        expect(conn).toContain('provider="Other"');
        expect(conn).toContain('access_key_id="a"');
        expect(conn).toContain('secret_access_key="s"');
        expect(conn.endsWith(':bucket')).toBe(true);
    });
});
