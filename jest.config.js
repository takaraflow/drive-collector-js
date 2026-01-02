export default {
  preset: null,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(@microlabs/otel-cf-workers|@opentelemetry/api)/)'
  ],
  forceExit: false,
  detectOpenHandles: true,
  testTimeout: 30000,
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: '100%',
  cache: true,
  cacheDirectory: '<rootDir>/.jest-cache',
  moduleNameMapper: {
    '^@microlabs/otel-cf-workers$': '<rootDir>/tests/mocks/otel-cf-workers.js',
    '^@opentelemetry/api$': '<rootDir>/tests/mocks/opentelemetry-api.js',
    '^redis-on-workers$': '<rootDir>/tests/mocks/redis-on-workers.js',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  // 移除 fakeTimers 配置，由 setupFilesAfterEnv 统一管理
  bail: 0,
  verbose: false,
  reporters: ['default'],
  detectLeaks: false,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**'
  ],
};