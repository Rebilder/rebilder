// Flat ESLint config for the Cloudflare Worker example. Same shape as the
// sibling packages — framework-agnostic TypeScript, no build step.
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.wrangler/**'],
  },
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'security/detect-object-injection': 'off',
    },
  },
  {
    // The template's own tests read this directory's files by computed path to
    // assert it still survives `cp -r`. Nothing here handles user input, and
    // the deployed Worker has no filesystem at all.
    files: ['test/**/*.ts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
)
