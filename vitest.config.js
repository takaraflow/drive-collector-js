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
    bail: 0,  // 禁用 bail，看到所有测试结果
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
  },
  poolOptions: {
    forks: {
      execArgv: ['--max-old-space-size=8192'],
      isolate: true,
    },
  },
})
