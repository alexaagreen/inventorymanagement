import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    globalSetup: ['tests/global-setup.js'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
