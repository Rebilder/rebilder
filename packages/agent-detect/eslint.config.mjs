// Flat ESLint config for @rebilder/agent-detect. The same shape as the sibling
// package configs, with no Next/React layers — this package is
// framework-agnostic pure TypeScript. Run with `pnpm lint`.
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
)
