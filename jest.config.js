export default {
  preset: null,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$))'
  ],
  forceExit: true,
  detectOpenHandles: false, // 禁用以提高性能，注意可能隐藏资源泄漏
  testTimeout: 30000, // 增加超时时间
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: 16, // 增加并行测试数以提升速度
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup/external-mocks.js',
    '<rootDir>/__tests__/setup/global-setup.js'
  ],
};