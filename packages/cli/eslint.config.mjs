// Flat ESLint config for `rebilder` (packages/cli). Copied from the sibling
// packages; this one is plain TypeScript over node: builtins.
//
// The extra rule below is the zero-runtime-dependency contract made mechanical:
// `no-restricted-imports` denies every node: module that opens a socket. The CLI
// makes exactly one kind of outbound request — the probe, which lives in
// `@rebilder/agent-readability/probe` and is the only place in the product
// allowed to hold a socket. A `fetch` added here would be indistinguishable from
// telemetry in a diff, so it is not a review question.
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
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'The CLI ships zero telemetry and makes no network call of its own. The only outbound requests are the probe, which lives in @rebilder/agent-readability/probe.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:http',
              message:
                'Only @rebilder/agent-readability/probe may open a socket. See README § Zero telemetry.',
            },
            {
              name: 'node:https',
              message:
                'Only @rebilder/agent-readability/probe may open a socket. See README § Zero telemetry.',
            },
            {
              name: 'node:net',
              message:
                'Only @rebilder/agent-readability/probe may open a socket. See README § Zero telemetry.',
            },
            {
              name: 'node:dgram',
              message:
                'Only @rebilder/agent-readability/probe may open a socket. See README § Zero telemetry.',
            },
          ],
        },
      ],
    },
  },
)
