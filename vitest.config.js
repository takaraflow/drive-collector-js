import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
    exclude: [
      '**/node_modules/**'
    ],
    globals: true,
    testTimeout: 20000,
    clearMocks: true,
    restoreMocks: true,
    maxWorkers: 1,
    minWorkers: 1,
    pool: 'forks',
    bail: 1,
  },
  poolOptions: {
    forks: {
      execArgv: ['--max-old-space-size=8192'],
      isolate: true,
    },
    reporters: ['default'],
    setupFiles: ['./test-setup.js'],
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
