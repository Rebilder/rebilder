/**
 * Build config for `@rebilder/gateway` — the merchant-installed artifact.
 *
 * Six entries, one per declared export condition. The adapter sub-paths are
 * separate entries rather than re-exports from `"."` so a Cloudflare Worker
 * importing `@rebilder/gateway/edge` never pulls the Node adapter's code into
 * its bundle; on a platform with a hard size ceiling that is the difference
 * between installable and not.
 *
 * `splitting` stays at its default (on for ESM): the six entries share the
 * core classify/handle/render modules, and a shared chunk is how they stay one
 * copy at runtime. The CJS build cannot split, so it duplicates — accepted,
 * because CJS consumers import one adapter, not six.
 *
 * The three `@rebilder/*` workspace dependencies are externalised automatically
 * (tsup externalises everything in `dependencies`). That is a deliberate
 * release decision: they publish as real packages and
 * `pnpm publish` rewrites `workspace:*` to the exact version, so a merchant
 * gets one copy of the renderer, not one per dependent.
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    next: 'src/adapters/next/index.ts',
    node: 'src/adapters/node/index.ts',
    edge: 'src/adapters/edge/index.ts',
    shopify: 'src/adapters/shopify/index.ts',
    fetch: 'src/adapters/fetch/index.ts',
  },
  format: ['esm', 'cjs'],
  // `incremental` is on in `tsconfig.base.json` for fast local typechecks, and
  // tsc refuses it when emitting declarations to a directory (TS5074). Turning
  // it off for the declaration pass only keeps the editor experience intact.
  dts: { compilerOptions: { incremental: false } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
})
