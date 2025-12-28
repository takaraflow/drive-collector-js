export default {
  preset: null,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$))'
  ],
  forceExit: true,
  detectOpenHandles: true,
  testTimeout: 30000, // 增加超时时间
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: 4,
};