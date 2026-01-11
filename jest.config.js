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
  testTimeout: 5000, // 严格控制5秒超时
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: 4, // 限制工作进程
  // 使用 fake timers 进行确定性测试
  fakeTimers: {
    enableGlobally: false, // Let individual tests control fake timers
    legacyFakeTimers: false,
    doNotFake: ['nextTick', 'setImmediate']
  },
  // 全局设置文件
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup/consoleMock.js',
    '<rootDir>/__tests__/setup/timeMocks.js',
    '<rootDir>/__tests__/setup/mathMocks.js',
    '<rootDir>/__tests__/setup/external-mocks.js',
    '<rootDir>/__tests__/setup/global-setup.js'
  ],
  // 性能和稳定性设置
  bail: 0, // 不在第一次失败时停止
  verbose: false, // 减少详细输出
  reporters: [
    'default'
  ],
  testPathIgnorePatterns: [
    '<rootDir>/__tests__/integration/startup-resilience.test.js',
    '<rootDir>/__tests__/integration/telegram-flood-wait.test.js'
  ],
  // 禁用泄漏检测以提升性能
  detectLeaks: false,
  // 收集测试覆盖率时的优化
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**'
  ],
  moduleDirectories: ["node_modules"],
  testEnvironment: "node",
};
