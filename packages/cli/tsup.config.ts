/**
 * Build config for `rebilder` — the binary behind `npx rebilder check`.
 *
 * TWO CONFIGS, because the two entry points are different products and want
 * different output.
 *
 *  1. `src/bin.ts` -> `dist/bin.js`. ESM only, no `.d.ts`, no splitting: `npx`
 *     resolves and executes exactly one path, and a chunk directory in between
 *     is one more thing that can be half-published. Nobody imports a bin, so a
 *     CJS twin and a declaration file would be pure tarball weight. esbuild
 *     preserves the `#!/usr/bin/env node` line from `src/bin.ts` and tsup marks
 *     the output executable; the release workflow verifies both before it
 *     publishes, because a bin without a shebang is an install that fails
 *     only on the user's machine.
 *
 *  2. `src/index.ts` -> `dist/index.js` + `dist/index.d.ts`. ESM only, because
 *     that is all `exports` publishes: the map has no `require` condition, so a
 *     CJS twin was unreachable weight in every tarball. A CommonJS tool on the
 *     supported Node versions (22.12+) can still `require()` this ESM entry.
 *
 * `clean` runs on the first config only; the second would otherwise delete the
 * bin that the first just wrote.
 *
 * `@rebilder/agent-readability` is externalised, not bundled, and published as
 * its own package. Bundling the scorer here would ship a second copy of
 * ARS whose version is whatever the CLI's version says, and a standard with two
 * implementations in one install is not a standard.
 */
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'node22',
    platform: 'node',
    outDir: 'dist',
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    // `incremental` is on in `tsconfig.base.json` for fast local typechecks, and
    // tsc refuses it when emitting declarations to a directory (TS5074). Turning
    // it off for the declaration pass only keeps the editor experience intact.
    dts: { compilerOptions: { incremental: false } },
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    target: 'node22',
    platform: 'node',
    outDir: 'dist',
  },
])
