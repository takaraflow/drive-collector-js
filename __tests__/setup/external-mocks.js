// __tests__/setup/external-mocks.js
import { jest } from '@jest/globals';

// Create mock functions
export const mockAxiomIngest = jest.fn().mockResolvedValue(undefined);
export const mockAxiomConstructor = jest.fn().mockImplementation(() => ({
  ingest: mockAxiomIngest
}));
export const mockQstashPublish = jest.fn().mockImplementation((options) => {
  // Reject if body contains "fail"
  if (options?.body?.includes && options.body.includes("fail")) {
    return Promise.reject(new Error("fail"));
  }
  return Promise.resolve({ messageId: 'mock-id' });
});
export const mockQstashVerify = jest.fn().mockImplementation(({ signature }) => {
  if (signature === 'invalid_signature') {
    return Promise.reject(new Error('Invalid signature'));
  }
  return Promise.resolve(true);
});
export const mockS3Send = jest.fn().mockResolvedValue({});
export const mockUpload = jest.fn();

// Mock Axiom (logger.js)
jest.unstable_mockModule('@axiomhq/js', () => ({
  Axiom: mockAxiomConstructor
}));

// Mock QStash
jest.unstable_mockModule('@upstash/qstash', () => ({
  Client: jest.fn().mockImplementation(() => ({
    publish: mockQstashPublish,
    publishJSON: mockQstashPublish, // Alias for publishJSON
    // 添加其他方法
  })),
  Receiver: jest.fn().mockImplementation(() => ({
    verify: mockQstashVerify
  }))
}));

// Mock AWS S3
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: mockS3Send,
    // ...
  }))
}));

// Mock @aws-sdk/lib-storage if needed
jest.unstable_mockModule('@aws-sdk/lib-storage', () => ({
  Upload: mockUpload
}));