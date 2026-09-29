// Flat ESLint config for @rebilder/mcp-server. Mirrors the sibling package
// configs and adds the one rule that makes this package's central promise
// checkable at build time rather than reviewable by eye.
//
// ZERO TELEMETRY IS A CONTRACT (design §5.6). "The CLI and MCP server never
// upload a scan." A developer pointing their assistant at an internal staging
// host must not have hostnames, paths or page bodies leave their machine. The
// README states it; this rule enforces it: nothing under `src/` may reference
// `fetch`, `XMLHttpRequest`, `WebSocket` or `navigator.sendBeacon` — with a
// single exemption for `src/index-client.ts`, which implements the one network
// call the binary makes by default (`get_index_entry`, a read of our public
// index API).
//
// The scan itself does reach the network, and deliberately so: it runs through
// `@rebilder/agent-readability`'s `./probe` on the USER's machine, against the
// host the user asked about. That is the whole architecture — no scan traffic
// is proxied through us, and no scan result is sent to us.
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'

/** Network globals banned everywhere except the public-index client. */
const NETWORK_GLOBALS = [
  {
    name: 'fetch',
    message:
      'Zero telemetry (design §5.6): the only network call this binary makes by default is the public-index read in src/index-client.ts. Scanning happens through @rebilder/agent-readability/probe on the user’s machine and its results are never uploaded.',
  },
  {
    name: 'XMLHttpRequest',
    message: 'Zero telemetry (design §5.6). See src/index-client.ts.',
  },
  {
    name: 'WebSocket',
    message:
      'Zero telemetry (design §5.6), and the HTTP transport is deferred — stdio is the only transport this package ships.',
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
    files: ['src/**/*.ts'],
    ignores: ['src/index-client.ts'],
    rules: {
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS],
      'no-restricted-properties': [
        'error',
        {
          object: 'navigator',
          property: 'sendBeacon',
          message: 'Zero telemetry (design §5.6). Nothing here reports anything to us.',
        },
      ],
    },
  },
)
