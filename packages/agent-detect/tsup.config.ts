/**
 * Build config for `@rebilder/agent-detect`.
 *
 * One entry, two formats. `dts` is on because the package ships types as its
 * primary product — a detection result whose shape is only knowable by reading
 * our source is not a public artifact.
 *
 * `target: 'es2022'` matches `tsconfig.base.json`; anything lower would down-
 * level syntax the runtimes we support (Node 20+, modern edge) execute natively.
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
