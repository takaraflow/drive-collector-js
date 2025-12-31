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
  testTimeout: 30000, // 恢复到 30s，避免超时
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: '100%', // 满 CPU 利用
  // 优化测试运行性能
  cache: true,
  cacheDirectory: '<rootDir>/.jest-cache',
  // 优先快测试
  testSequencer: '<rootDir>/jest-sequencer.js',
  // 全局 fake timers（减少真实定时器等待）
  fakeTimers: {
    enableGlobally: false, // 不全局启用，避免破坏依赖真实时间的集成测试
    legacyFakeTimers: false
  },
  // 优化全局设置
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup/external-mocks.js',
    '<rootDir>/__tests__/setup/global-setup.js'
  ],
  // 性能优化：减少冗余
  bail: 0, // 不在第一次失败时停止
  verbose: false, // 减少详细输出以提升性能
  // 恢复进度条和预估时间
  reporters: [
    'default'
  ],
  // 禁用泄漏检测以提升性能
  detectLeaks: false,
  // 收集测试覆盖率时的优化
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**'
  ],
};
