import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFs = {
  existsSync: jest.fn(),
  statSync: jest.fn(),
  createReadStream: jest.fn()
};

jest.unstable_mockModule('fs', () => ({ default: mockFs }));

const mockPath = {
  basename: jest.fn()
};

jest.unstable_mockModule('path', () => ({ default: mockPath }));

jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {
    oss: {
      workerUrl: 'http://test.worker',
      workerSecret: 'test-secret',
      r2: {
        endpoint: 'https://test.r2',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        bucket: 'test-bucket',
        publicUrl: 'https://test.public'
      }
    }
  }
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: mockLogger
}));

const mockOssHelper = {
  uploadToS3: jest.fn(),
  getPublicUrl: jest.fn().mockReturnValue('https://test/public/remote.mp4')
};

jest.unstable_mockModule('../../src/utils/oss-helper.js', () => ({
  ossHelper: mockOssHelper
}));

const mockCloudTool = {
  uploadFile: jest.fn()
};

jest.unstable_mockModule('../../src/services/rclone.js', () => ({
  CloudTool: mockCloudTool
}));

const mockFetch = jest.fn();

global.fetch = mockFetch;

const { ossService } = await import('../../src/services/oss.js');

describe('OSSService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ size: 1024 });
    mockPath.basename.mockReturnValue('test.mp4');
  });

  it('should upload via worker when success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, url: 'https://worker/url' })
    });

    const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

    expect(result.success).toBe(true);
    expect(result.method).toBe('worker');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockOssHelper.uploadToS3).not.toHaveBeenCalled();
    expect(mockCloudTool.uploadFile).not.toHaveBeenCalled();
  });

  it('should fallback to S3 when worker fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Worker error'));

    mockOssHelper.uploadToS3.mockResolvedValueOnce({ Location: 's3://location' });

    const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

    expect(result.success).toBe(true);
    expect(result.method).toBe('s3');
    expect(mockOssHelper.uploadToS3).toHaveBeenCalledTimes(1);
    expect(mockCloudTool.uploadFile).not.toHaveBeenCalled();
  });

  it('should fallback to Rclone when S3 fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Worker error'));
    mockOssHelper.uploadToS3.mockRejectedValueOnce(new Error('S3 error'));

    mockCloudTool.uploadFile.mockResolvedValueOnce({ success: true });

    const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4', null, 'user123');

    expect(result.success).toBe(true);
    expect(result.method).toBe('rclone');
    expect(mockCloudTool.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('should fail when all paths fail', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Worker error'));
    mockOssHelper.uploadToS3.mockRejectedValueOnce(new Error('S3 error'));
    mockCloudTool.uploadFile.mockRejectedValueOnce(new Error('Rclone error'));

    const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4', null, 'user123');

    expect(result.success).toBe(false);
  });

  it('should throw if file not exist', async () => {
    mockFs.existsSync.mockReturnValueOnce(false);

    await expect(ossService.upload('/tmp/nonexist.mp4', 'remote.mp4')).rejects.toThrow('文件不存在');
  });
});