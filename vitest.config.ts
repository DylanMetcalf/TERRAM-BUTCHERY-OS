import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    pool: 'forks',
    env: { TERRAM_DISABLE_AI: '1' },
  },
});
