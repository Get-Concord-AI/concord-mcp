// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Coding rules (see CLAUDE.md): hard file-size ceiling.
      'max-lines': ['error', { max: 1000, skipBlankLines: false, skipComments: false }],

      // Never typecast: forbid `as` assertions entirely (`as const` still allowed).
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],

      // Clear, predictable naming.
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
        {
          selector: 'variable',
          modifiers: ['const', 'exported'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
        },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        // Allow arbitrary object keys (JSON payloads, DB columns, MCP fields).
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'typeProperty', format: null },
      ],
    },
  },
  {
    // Config files: no type-aware linting required.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
