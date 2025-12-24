import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  },
  resolve: {
    extensions: ['.js', '.mjs'],
    alias: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
    },
  },
  esbuild: {
    target: 'node18',
  },
});