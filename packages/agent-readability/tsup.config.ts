/**
 * Build config for `@rebilder/agent-readability`.
 *
 * Three entries, and the split between them is a security boundary, not a
 * packaging preference (see `src/probe/local.ts`): `"."` is the pure scorer,
 * `"./probe"` is the strict server-side fetcher, `"./probe/local"` is the
 * capability that throws at import time without `--allow-private`. Bundling
 * them into one file would erase exactly the property that makes the third one
 * safe — that importing the first two cannot reach it.
 *
 * `splitting: false`. ESM code-splitting would hoist whatever `probe/index` and
 * `probe/local` share into a common chunk, which is harmless today but means
 * the reachability of `local` from `probe` becomes a property of the bundler's
 * chunk graph rather than of the import graph. Three self-contained files are
 * auditable by reading them.
 *
 * `src/probe/ssrf.ts` is not an entry, and must not become one: it is reachable
 * only through `./probe`, which is what keeps the guard non-bypassable.
 *
 * SOURCEMAPS SHIP WITH THE ESM BUILD ONLY. Each map carries the full
 * `sourcesContent`, and with three self-contained entries the ESM and CJS maps
 * were six near-identical copies of the same TypeScript: about 2.2 MB of a
 * 3 MB tarball. The ESM maps keep the original source on npm for anyone
 * debugging the scorer; CommonJS consumers get the same code without a second
 * copy of its maps.
 */
import { defineConfig, type Options } from 'tsup'

const shared: Options = {
  entry: {
    index: 'src/index.ts',
    'probe/index': 'src/probe/index.ts',
    'probe/local': 'src/probe/local.ts',
  },
  // `incremental` is on in `tsconfig.base.json` for fast local typechecks, and
  // tsc refuses it when emitting declarations to a directory (TS5074). Turning
  // it off for the declaration pass only keeps the editor experience intact.
  dts: { compilerOptions: { incremental: false } },
  splitting: false,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
}

export default defineConfig([
  { ...shared, format: ['esm'], sourcemap: true, clean: true },
  // The first config cleans; cleaning here too would delete the ESM output.
  { ...shared, format: ['cjs'], sourcemap: false, clean: false },
])
