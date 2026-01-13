import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default {
  testEnvironment: 'node',
  globals: true,
  setupFiles: ['./__tests__/vitest.setup.js'],
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  resolve: {
    alias: {
      '@microlabs/otel-cf-workers': resolve(__dirname, './__tests__/mocks/otel-cf-workers.js'),
      '@opentelemetry/api': resolve(__dirname, './__tests__/mocks/opentelemetry-api.js'),
      'redis-on-workers': resolve(__dirname, './__tests__/mocks/redis-on-workers.js'),
    }
  },
  coverage: {
    provider: 'v8',
    include: ['src/**/*.js'],
    exclude: ['**/node_modules/**', '**/*.test.js', '**/*.spec.js']
  },
  deps: {
    external: ['@opentelemetry/api', '@microlabs/otel-cf-workers', 'redis-on-workers']
  }
};