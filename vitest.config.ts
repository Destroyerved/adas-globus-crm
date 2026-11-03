import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
          testTimeout: 30000,
        },
      },
    ],
  },
});
