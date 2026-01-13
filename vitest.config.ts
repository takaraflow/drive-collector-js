import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.spec.ts", "__tests__/**/*.test.js"],
    exclude: ["test/lifecycle.unit.test.ts"],
    testTimeout: 60000,
    environment: 'node',
  },
  define: {
    // Mock Node.js globals that aren't available in the test environment
    global: 'globalThis',
  },
});