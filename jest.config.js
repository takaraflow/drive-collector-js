export default {
  preset: null,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  // eÍ\
  forceExit: true,
  detectOpenHandles: true,
  //  …ööôåeÍ\
  testTimeout: 10000,
  // D
  clearMocks: true,
  restoreMocks: true,
};