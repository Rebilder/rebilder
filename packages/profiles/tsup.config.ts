/**
 * Build config for `@rebilder/profiles`.
 *
 * The eight JSON profiles are inlined into `dist/index.js` by esbuild, so the
 * JavaScript consumer needs no filesystem access and the package works in an
 * edge runtime. The JSON files are ALSO published verbatim (`files` includes
 * `profiles/`, and `exports["./profiles/*"]` points at them) because the README
 * promises a Go or Python implementation can read `profiles/place.json` with
 * its standard library. Two readings of the same bytes; neither is privileged.
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
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
