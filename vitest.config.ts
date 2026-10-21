import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // No test files exist until the storage/tool PRs land; don't fail the scaffold.
    passWithNoTests: true,
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup-home.ts'],
    // The cross-harness suite packs and installs Concord; it runs via `pnpm e2e`.
    exclude: ['test/e2e/**', 'node_modules/**'],
    // Windows runners spawn processes far slower, and many tests run fake harness CLIs.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
