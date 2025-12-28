import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {
    oss: {
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
  debug: jest.fn()
};

jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: mockLogger
}));

jest.mock('fs', () => ({
  createReadStream: jest.fn()
}));

const { ossHelper } = await import('../../src/utils/oss-helper.js');

describe('OSSHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize S3Client with valid config', () => {
    expect(ossHelper.s3Client).toBeDefined();
  });

  it('should get public URL', () => {
    const url = ossHelper.getPublicUrl('test.mp4');
    expect(url).toBe('https://test.public/test.mp4');
  });

  it('should upload to S3 successfully', async () => {
    const mockUpload = {
      on: jest.fn(),
      done: jest.fn().mockResolvedValue({ Location: 's3://test' })
    };
    const { Upload: UploadMock } = await import('@aws-sdk/lib-storage');
    UploadMock.mockReturnValue(mockUpload);

    // Mock fs.createReadStream to return a readable stream
    jest.spyOn(fs, 'createReadStream').mockReturnValue(Readable.from('test content'));

    const result = await ossHelper.uploadToS3('./test.mp4', 'remote.mp4');

    expect(UploadMock).toHaveBeenCalledTimes(1);
    expect(mockUpload.done).toHaveBeenCalledTimes(1);
    expect(result.Location).toBe('s3://test');
  });

  it('should throw if S3 client not initialized', async () => {
    // Manually set s3Client to null to simulate uninitialized state
    const originalS3Client = ossHelper.s3Client;
    ossHelper.s3Client = null;

    // Mock fs.createReadStream to return a readable stream
    jest.spyOn(fs, 'createReadStream').mockReturnValue(Readable.from('test content'));

    await expect(ossHelper.uploadToS3('./test.mp4', 'remote.mp4')).rejects.toThrow('S3 客户端未初始化');

    // Restore original s3Client
    ossHelper.s3Client = originalS3Client;
  });
});