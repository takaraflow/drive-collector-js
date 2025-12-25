export default {
  preset: null,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  forceExit: true,
  detectOpenHandles: true,
  testTimeout: 10000,
  clearMocks: true,
  restoreMocks: true,
};