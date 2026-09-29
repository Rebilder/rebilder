// Flat ESLint config for @rebilder/agent-readability. Mirrors the sibling
// package configs (packages/agent-detect/eslint.config.mjs) and adds the rule
// that makes this package's central claim checkable at build time.
//
// PURITY IS THE PRODUCT (design §3.2). The determinism guarantee is: for a
// given evidenceHash, rulesetHash and corpusHash, score() returns a
// byte-identical ArsResult in any conformant implementation, in any language.
// That is false the moment the scoring path reads a clock, a random number, or
// the network. So `src/` — everything except `src/probe/`, which is the
// deliberately impure half — may not reference `Date`, `Math.random`, `fetch`
// or `performance`. Conformance fixture `055-no-network` and `056-no-clock`
// point at THIS rule: a runtime stub would only prove that our own fixtures
// avoid those globals, whereas a lint rule fails the build for code that has
// not been written yet.
//
// `no-restricted-globals` only sees bare global identifiers, so `Math.random`
// (a member expression on a permitted global) needs `no-restricted-properties`
// as well. Both are errors; neither has an escape hatch in this package.
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'

/** Globals banned from the pure half. Design §3.2, verbatim. */
const IMPURE_GLOBALS = [
  {
    name: 'Date',
    message:
      'The scorer is a pure function of its evidence bundle. Wall-clock time is captured by the probe (ArsEvidence.capturedAt) and is excluded from evidenceHash.',
  },
  {
    name: 'fetch',
    message:
      'The scorer never makes a network call. All HTTP lives in src/probe/ and reaches score() only as ArsEvidence.',
  },
  {
    name: 'performance',
    message:
      'performance.now() is a clock. Timing belongs in the probe or the caller, never in the scoring path.',
  },
]

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
    // The pure half. src/probe/ is exempt: it is the impure half by design.
    files: ['src/**/*.ts'],
    ignores: ['src/probe/**'],
    rules: {
      'no-restricted-globals': ['error', ...IMPURE_GLOBALS],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'The scorer is deterministic: same evidence, same ruleset, same result, byte for byte. There is no tie to break with a coin flip.',
        },
      ],
    },
  },
)
