import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

// Mock AWS SDK modules first
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(function() {
    this.send = vi.fn();
  })
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(function() {
    this.on = vi.fn();
    this.done = vi.fn().mockResolvedValue({ Location: 's3://test' });
  })
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    oss: {
      endpoint: 'https://test.r2',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      bucket: 'test-bucket',
      publicUrl: 'https://test.public'
    }
  },
  getConfig: vi.fn().mockReturnValue({
    oss: {
      endpoint: 'https://test.r2',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      bucket: 'test-bucket',
      publicUrl: 'https://test.public'
    }
  })
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withModule: vi.fn().mockReturnThis(),
  withContext: vi.fn().mockReturnThis()
};

vi.mock('../../src/services/logger/index.js', () => ({
  default: mockLogger,
  logger: mockLogger
}));

vi.mock('fs', () => ({
  default: {
    createReadStream: vi.fn()
  },
  createReadStream: vi.fn()
}));

const { ossHelper } = await import('../../src/utils/oss-helper.js');

describe('OSSHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize S3Client with valid config', () => {
    expect(ossHelper.s3Client).toBeDefined();
  });

  it('should get public URL', () => {
    const url = ossHelper.getPublicUrl('test.mp4');
    expect(url).toBe('https://test.public/test.mp4');
  });

  it('should upload to S3 successfully', async () => {
    // Mock fs.createReadStream to return a readable stream
    vi.spyOn(fs, 'createReadStream').mockReturnValue(Readable.from('test content'));

    const result = await ossHelper.uploadToS3('./test.mp4', 'remote.mp4');

    // Verify Upload was called with correct parameters
    const { Upload } = await import('@aws-sdk/lib-storage');
    expect(Upload).toHaveBeenCalledTimes(1);
    expect(result.Location).toBe('s3://test');
  });

  it('should throw if S3 client not initialized', async () => {
    // Manually set s3Client to null to simulate uninitialized state
    const originalS3Client = ossHelper.s3Client;
    ossHelper.s3Client = null;

    // Mock fs.createReadStream to return a readable stream
    vi.spyOn(fs, 'createReadStream').mockReturnValue(Readable.from('test content'));

    await expect(ossHelper.uploadToS3('./test.mp4', 'remote.mp4')).rejects.toThrow('S3 客户端未初始化');

    // Restore original s3Client
    ossHelper.s3Client = originalS3Client;
  });
});