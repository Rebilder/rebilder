// Flat ESLint config for @rebilder/render-md. This package is framework-agnostic
// (no React/Next), so it lints with plain @eslint/js + typescript-eslint.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  {
    files: ['**/*.ts', '**/*.mts', '**/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
