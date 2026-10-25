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
    // Real harness binaries occasionally stall on their own (a slow start, a
    // dropped pty read). One retry on CI absorbs that; a real regression fails
    // both attempts. Locally a failure shows at once.
    retry: process.env['CI'] === 'true' ? 1 : 0,
  },
});
