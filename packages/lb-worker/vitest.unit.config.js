import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@microlabs/otel-cf-workers': resolve(__dirname, './__tests__/mocks/otel-cf-workers.js'),
      '@opentelemetry/api': resolve(__dirname, './__tests__/mocks/opentelemetry-api.js'),
      'redis-on-workers': resolve(__dirname, './__tests__/mocks/redis-on-workers.js'),
    }
  },
  test: {
    name: 'unit',
    environment: 'node',
    globals: true,
    setupFiles: ['./__tests__/vitest.setup.js'],
    disableConsoleIntercept: true,
    include: [
      '__tests__/**/*.test.js',
      '__tests__/**/*.test.ts',
      '__tests__/**/*.spec.js',
      '__tests__/**/*.spec.ts'
    ],
    exclude: ['test/**', '**/node_modules/**', '__tests__/lifecycle.unit.test.ts'],
    deps: {
      optimizer: {
        ssr: {
          exclude: ['@opentelemetry/api', '@microlabs/otel-cf-workers', 'redis-on-workers']
        }
      }
    },
  },
});
