export default {
  preset: null,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$))'
  ],
  forceExit: true,
  detectOpenHandles: false,
  testTimeout: 30000,
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: '50%', // 使用 CPU 核心数的 50% 以避免过度占用系统资源
  // 优化测试运行性能
  cache: true,
  cacheDirectory: '<rootDir>/.jest-cache',
  // 并行化测试套件
  runInBand: false,
  // 优化全局设置
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup/external-mocks.js',
    '<rootDir>/__tests__/setup/global-setup.js'
  ],
  // 性能优化：减少冗余
  bail: 0, // 不在第一次失败时停止
  verbose: false, // 减少详细输出以提升性能
  // 收集测试覆盖率时的优化
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**'
  ],
};