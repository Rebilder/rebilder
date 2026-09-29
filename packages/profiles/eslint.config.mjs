// Flat ESLint config for @rebilder/profiles. Copied from the sibling packages
// (packages/agent-detect/eslint.config.mjs) — this package is framework-agnostic
// pure TypeScript plus JSON data. Run with `pnpm lint`.
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
