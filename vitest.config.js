import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
    exclude: [
      '**/node_modules/**'
    ],
    globals: true,
    testTimeout: 5000,
    clearMocks: true,
    restoreMocks: true,
    maxWorkers: 4,
    bail: 0,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/__tests__/**',
        '**/*.test.js',
        '**/*.spec.js'
      ],
      include: ['src/**/*.js']
    }
  }
})