export default {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  transformIgnorePatterns: [
    'node_modules/(?!(@microlabs/otel-cf-workers|@opentelemetry/api)/)'
  ],
  moduleNameMapper: {
    '^@microlabs/otel-cf-workers$': '<rootDir>/tests/mocks/otel-cf-workers.js',
    '^@opentelemetry/api$': '<rootDir>/tests/mocks/opentelemetry-api.js',
  },
  forceExit: true,
  detectOpenHandles: true,
  testTimeout: 30000,
  clearMocks: true,
  restoreMocks: true,
  maxWorkers: '50%',
};