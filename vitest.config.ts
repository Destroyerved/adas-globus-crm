import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // With TEST_DATABASE_URL every integration file rebuilds the same real database, so test
    // files must run one after another. PGlite gives each file its own, so they run together.
    // (The setting only takes effect here, not inside a project.)
    fileParallelism: !process.env['TEST_DATABASE_URL'],
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/api/src/**/*.test.ts',
            'apps/web/src/**/*.test.{ts,tsx}',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/api/src/**/*.int.test.ts', 'packages/**/src/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          // Each file builds its own PGlite database (every migration plus the seed) on first
          // use. With six files building at once on a busy machine that has taken just over
          // 30s, so the first test or hook in a file gets 90s; a real hang still fails.
          testTimeout: 90000,
          hookTimeout: 90000,
        },
      },
    ],
  },
});
