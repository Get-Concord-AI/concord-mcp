import { defineConfig } from 'vitest/config';

/** Cross-harness end-to-end suite: `pnpm e2e`. See test/e2e/README.md. */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/e2e/**/*.e2e.test.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
