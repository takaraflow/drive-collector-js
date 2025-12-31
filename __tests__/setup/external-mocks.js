// __tests__/setup/external-mocks.js
import { jest } from '@jest/globals';

// 全局 mock 对象 - 在测试套件间共享，减少重复创建
const globalMocks = {
  axiomIngest: null,
  axiomConstructor: null,
  qstashPublish: null,
  qstashVerify: null,
  s3Send: null,
  upload: null,
  cache: null,
  localCache: null
};

// 创建 mock 函数（只创建一次）
globalMocks.axiomIngest = jest.fn().mockResolvedValue(undefined);
globalMocks.axiomConstructor = jest.fn().mockImplementation(() => ({
  ingest: globalMocks.axiomIngest
}));

globalMocks.qstashPublish = jest.fn().mockImplementation((options) => {
  // Reject if body contains "fail"
  if (options?.body?.includes && options.body.includes("fail")) {
    return Promise.reject(new Error("fail"));
  }
  return Promise.resolve({ messageId: 'mock-id' });
});

globalMocks.qstashVerify = jest.fn().mockImplementation(({ signature }) => {
  if (signature === 'invalid_signature') {
    return Promise.reject(new Error('Invalid signature'));
  }
  return Promise.resolve(true);
});

globalMocks.s3Send = jest.fn().mockResolvedValue({});
globalMocks.upload = jest.fn();

// 全局 mock 对象（可重用）
globalMocks.cache = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    listKeys: jest.fn(),
    bulkSet: jest.fn(),
    isFailoverMode: false,
    getCurrentProvider: jest.fn().mockReturnValue('Cloudflare KV')
};

globalMocks.localCache = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    clear: jest.fn(),
    isUnchanged: jest.fn().mockReturnValue(false)
};

// Mock Axiom (logger.js) - 使用全局 mock
jest.unstable_mockModule('@axiomhq/js', () => ({
  Axiom: globalMocks.axiomConstructor
}));

// Mock QStash - 使用全局 mock
jest.unstable_mockModule('@upstash/qstash', () => ({
  Client: jest.fn().mockImplementation(() => ({
    publish: globalMocks.qstashPublish,
    publishJSON: globalMocks.qstashPublish,
  })),
  Receiver: jest.fn().mockImplementation(() => ({
    verify: globalMocks.qstashVerify
  }))
}));

// Mock AWS S3 - 使用全局 mock
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: globalMocks.s3Send,
  }))
}));

// Mock @aws-sdk/lib-storage - 使用全局 mock
jest.unstable_mockModule('@aws-sdk/lib-storage', () => ({
  Upload: globalMocks.upload
}));

// 导出全局 mock 对象供测试使用
export {
  globalMocks
};

// 导出单个 mock 函数（向后兼容）
export const mockAxiomIngest = globalMocks.axiomIngest;
export const mockAxiomConstructor = globalMocks.axiomConstructor;
export const mockQstashPublish = globalMocks.qstashPublish;
export const mockQstashVerify = globalMocks.qstashVerify;
export const mockS3Send = globalMocks.s3Send;
export const mockUpload = globalMocks.upload;
export const mockCache = globalMocks.cache;
export const mockLocalCache = globalMocks.localCache;
