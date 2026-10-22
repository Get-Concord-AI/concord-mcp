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
    // Many tests spawn the CLI or fake harness CLIs, which is slow on a loaded
    // machine and slower still on Windows runners; a tight limit only flakes.
    testTimeout: process.platform === 'win32' ? 30_000 : 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
