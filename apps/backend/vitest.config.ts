import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: {
      MONGOMS_STARTUP_TIMEOUT: '60000',
    },
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
