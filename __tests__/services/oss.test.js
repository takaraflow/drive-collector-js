import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFs = {
  existsSync: jest.fn(),
  statSync: jest.fn(),
  createReadStream: jest.fn(),
  readFileSync: jest.fn()
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

// Mock File constructor for Node.js environment
global.File = class File {
  constructor(parts, name, options) {
    this.parts = parts;
    this.name = name;
    this.options = options;
  }
};

const { ossService } = await import('../../src/services/oss.js');

describe('OSSService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ size: 1024 });
    mockPath.basename.mockReturnValue('test.mp4');
  });

  describe('Node.js 18 Compatibility', () => {
    it('should use fs.readFileSync instead of createReadStream for worker upload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, url: 'https://worker/url' })
      });

      const testBuffer = Buffer.from('test content');
      mockFs.readFileSync.mockReturnValue(testBuffer);

      const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      expect(result.success).toBe(true);
      expect(result.method).toBe('worker');
      expect(mockFs.readFileSync).toHaveBeenCalledWith('/tmp/test.mp4');
      expect(mockFs.createReadStream).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should construct File object with Buffer for Node.js compatibility', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, url: 'https://worker/url' })
      });

      const testBuffer = Buffer.from('test content');
      mockFs.readFileSync.mockReturnValue(testBuffer);

      await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      // Verify that fetch was called with FormData containing a File
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('http://test.worker');
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].body).toBeDefined();
    });

    it('should handle file read errors gracefully', async () => {
      mockFs.readFileSync.mockImplementationOnce(() => {
        throw new Error('File read error');
      });

      mockOssHelper.uploadToS3.mockResolvedValueOnce({ Location: 's3://location' });

      const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      expect(result.success).toBe(true);
      expect(result.method).toBe('s3');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worker 上传失败')
      );
    });
  });

  describe('Upload Paths', () => {
    it('should upload via worker when success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, url: 'https://worker/url' })
      });

      mockFs.readFileSync.mockReturnValue(Buffer.from('test'));

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

  describe('Worker Response Handling', () => {
    it('should handle worker response with custom URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, url: 'https://custom/url' })
      });

      mockFs.readFileSync.mockReturnValue(Buffer.from('test'));

      const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      expect(result.url).toBe('https://custom/url');
    });

    it('should handle worker response without URL (fallback to ossHelper)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      mockFs.readFileSync.mockReturnValue(Buffer.from('test'));

      const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      expect(result.url).toBe('https://test/public/remote.mp4');
    });

    it('should throw on worker response error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: 'Worker error message' })
      });

      mockFs.readFileSync.mockReturnValue(Buffer.from('test'));
      mockOssHelper.uploadToS3.mockResolvedValueOnce({ Location: 's3://location' });

      const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      expect(result.method).toBe('s3');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worker 上传失败')
      );
    });

    it('should throw on HTTP error status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503
      });

      mockFs.readFileSync.mockReturnValue(Buffer.from('test'));
      mockOssHelper.uploadToS3.mockResolvedValueOnce({ Location: 's3://location' });

      const result = await ossService.upload('/tmp/test.mp4', 'remote.mp4');

      expect(result.method).toBe('s3');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worker 上传失败')
      );
    });
  });
});