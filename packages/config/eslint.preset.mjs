import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export const adasEslintConfig = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.pnpm-store/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      boundaries,
      'react-hooks': reactHooks,
    },
    settings: {
      'boundaries/elements': [
        {
          type: 'shared',
          pattern: 'packages/shared/src/**',
          mode: 'full',
        },
        {
          type: 'api-platform',
          pattern: 'apps/api/src/platform/**',
          mode: 'full',
        },
        {
          type: 'api-module-public',
          pattern: 'apps/api/src/modules/*/index.ts',
          capture: ['moduleName'],
          mode: 'file',
        },
        {
          type: 'api-module-internal',
          pattern: 'apps/api/src/modules/*/**',
          capture: ['moduleName'],
          mode: 'full',
        },
        {
          type: 'web-components-ui',
          pattern: 'apps/web/src/components/ui/**',
          mode: 'full',
        },
        {
          type: 'web-feature',
          pattern: 'apps/web/src/features/*/**',
          capture: ['featureName'],
          mode: 'full',
        },
      ],
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'boundaries/element-types': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              // platform/ never imports from modules/ (AGENTS.md §7, PRD §6.4)
              from: ['api-platform'],
              disallow: ['api-module-public', 'api-module-internal'],
              message:
                'Platform modules must never import from business modules (PRD §6.4, AGENTS.md §7).',
            },
            {
              // A module may only import another module's public index.ts, never its internals
              from: ['api-module-internal', 'api-module-public'],
              disallow: [['api-module-internal', { moduleName: '!${from.moduleName}' }]],
              message:
                'Modules must only import another module through its public index.ts surface (PRD §6.4, AGENTS.md §7).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '../modules/**', '../../modules/**'],
              message: 'platform/ must never import from modules/ (AGENTS.md §7).',
            },
          ],
        },
      ],
    },
  },
);

export default adasEslintConfig;
