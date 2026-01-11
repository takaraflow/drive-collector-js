import { vi } from 'vitest';

// 全局 mock 对象 - 在测试套件间共享，减少重复创建
const globalMocks = {
  axiomIngest: null,
  axiomConstructor: null,
  qstashPublish: null,
  qstashVerify: null,
  s3Send: null,
  upload: null,
  cache: null,
  localCache: null,
  redisClient: null,
  cloudflareClient: null,
  upstashClient: null
};

// 创建 mock 函数（只创建一次）
// Axiom ingest should return true for success (safeAxiomIngest expects truthy value)
globalMocks.axiomIngest = vi.fn().mockResolvedValue(true);
globalMocks.axiomConstructor = vi.fn().mockImplementation(function() {
  return {
    ingest: globalMocks.axiomIngest
  };
});

globalMocks.qstashPublish = vi.fn().mockImplementation((options) => {
  // Reject if body contains "fail"
  if (options?.body?.includes && options.body.includes("fail")) {
    return Promise.reject(new Error("fail"));
  }
  return Promise.resolve({ messageId: 'mock-id' });
});

globalMocks.qstashVerify = vi.fn().mockImplementation(({ signature }) => {
  if (signature === 'invalid_signature') {
    return Promise.reject(new Error('Invalid signature'));
  }
  return Promise.resolve(true);
});

globalMocks.s3Send = vi.fn().mockResolvedValue({});
globalMocks.upload = vi.fn();

// 全局 mock 对象（可重用）
globalMocks.cache = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn(),
    bulkSet: vi.fn(),
    stopRecoveryCheck: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    getCurrentProvider: vi.fn().mockReturnValue('Cloudflare KV'),
    get hasRedis() { return false; },
    get hasCloudflare() { return true; },
    get hasUpstash() { return false; },
    get providerName() { return 'cloudflare'; }
};

globalMocks.localCache = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    clear: vi.fn(),
    isUnchanged: vi.fn().mockReturnValue(false)
};

// Mock logger - Removed to allow tests to import the real logger module
// Tests that need to mock logger should do so explicitly in their own test files

// Mock QStash - 使用全局 mock
vi.mock('@upstash/qstash', () => ({
  Client: vi.fn().mockImplementation(() => ({
    publish: globalMocks.qstashPublish,
    publishJSON: globalMocks.qstashPublish,
  })),
  Receiver: vi.fn().mockImplementation(() => ({
    verify: globalMocks.qstashVerify
  }))
}));

// Mock AWS S3 - 使用全局 mock
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: globalMocks.s3Send,
  }))
}));

// Mock @aws-sdk/lib-storage - 使用全局 mock
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: globalMocks.upload
}));

// 导出全局 mock 对象供测试使用
export {
    globalMocks
};

const createRedisPipeline = () => ({
  set: vi.fn().mockReturnThis(),
  del: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([])
});

// Mock ioredis
globalMocks.redisClient = {
  on: vi.fn().mockReturnThis(),
  once: vi.fn().mockReturnThis(),
  removeListener: vi.fn().mockReturnThis(),
  removeAllListeners: vi.fn().mockReturnThis(),
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue('OK'),
  disconnect: vi.fn().mockResolvedValue('OK'),
  ping: vi.fn().mockResolvedValue('PONG'),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  exists: vi.fn().mockResolvedValue(0),
  incr: vi.fn().mockResolvedValue(1),
  eval: vi.fn().mockResolvedValue(1),
  scan: vi.fn().mockResolvedValue(['0', []]),
  keys: vi.fn().mockResolvedValue([]),
  pipeline: vi.fn(createRedisPipeline),
  multi: vi.fn(createRedisPipeline),
  status: 'ready',
  options: {
    maxRetriesPerRequest: 5,
    connectTimeout: 15000
  }
};

// Mock Cloudflare KV client
globalMocks.cloudflareClient = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue({ keys: [] }),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  getProviderName: vi.fn().mockReturnValue('cloudflare')
};

// Mock Upstash client
globalMocks.upstashClient = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  getProviderName: vi.fn().mockReturnValue('UpstashRHCache')
};

// RedisMock 构造函数 - 支持 new 关键字
const RedisMock = function(...args) {
  // 记录构造调用
  if (!RedisMock.mock) {
    RedisMock.mock = { calls: [], instances: [], clear: function() { this.calls = []; this.instances = []; } };
  }
  RedisMock.mock.calls.push(args);
  RedisMock.mock.instances.push(this);
  
  // 将 mock 方法绑定到实例
  Object.assign(this, globalMocks.redisClient);
  
  // 返回 this 以支持 new 关键字
  return this;
};

// 为 RedisMock 添加 mock 属性以支持测试
RedisMock.mock = {
  calls: [],
  instances: [],
  clear: function() {
    this.calls = [];
    this.instances = [];
  }
};

// 包装器 - 用于 vi.mock 的返回
const RedisMockWrapper = function(...args) {
  return new RedisMock(...args);
};

// 复制 mock 属性到包装器
RedisMockWrapper.mock = RedisMock.mock;
RedisMockWrapper.mockClear = function() {
  RedisMock.mock.clear();
  return RedisMockWrapper;
};

// 添加 mockClear 方法直接到 RedisMock（用于 RedisCache.test.js）
RedisMock.mockClear = function() {
  RedisMock.mock.clear();
  return RedisMock;
};

vi.mock('ioredis', () => ({
  default: RedisMockWrapper
}));

// ❌ 【Commented out】Mock CacheService - Removed to allow real class usage in tests
// vi.mock('../../src/services/CacheService.js', () => {
//   const MockCacheService = vi.fn().mockImplementation(() => globalMocks.cache);
//
//   return {
//     cache: globalMocks.cache,
//     CacheService: MockCacheService,
//     default: globalMocks.cache
//   };
// });

// 导出单个 mock 函数（向后兼容）
export const mockAxiomIngest = globalMocks.axiomIngest;
export const mockAxiomConstructor = globalMocks.axiomConstructor;
export const mockQstashPublish = globalMocks.qstashPublish;
export const mockQstashVerify = globalMocks.qstashVerify;
export const mockS3Send = globalMocks.s3Send;
export const mockUpload = globalMocks.upload;
export const mockCache = globalMocks.cache;
export const mockLocalCache = globalMocks.localCache;
export const mockRedisClient = globalMocks.redisClient;
export const mockRedisConstructor = RedisMock;