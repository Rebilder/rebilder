/**
 * Build config for `@rebilder/render-md`.
 *
 * On the gateway's hot path, so the bundle is treeshaken and the target is the
 * runtime's own (ES2022) — no down-levelling, no helpers, no polyfills.
 *
 * `src/internal/**` is deliberately NOT an entry: it is reachable only through
 * `"."`, which is what makes `@rebilder/render-md/internal` unresolvable rather
 * than merely discouraged (a project convention).
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
