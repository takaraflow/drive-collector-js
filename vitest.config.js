import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./__tests__/vitest.setup.js'],
    testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
    exclude: ['test/**', 'node_modules/**'],
    resolve: {
      alias: {
        '@microlabs/otel-cf-workers': resolve(__dirname, './__tests__/mocks/otel-cf-workers.js'),
        '@opentelemetry/api': resolve(__dirname, './__tests__/mocks/opentelemetry-api.js'),
        'redis-on-workers': resolve(__dirname, './__tests__/mocks/redis-on-workers.js'),
      }
    },
    deps: {
      external: ['@opentelemetry/api', '@microlabs/otel-cf-workers', 'redis-on-workers']
    },
  },
});
