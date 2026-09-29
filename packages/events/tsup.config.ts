/**
 * Build config for `@rebilder/events`.
 *
 * The event schema is a contract other people compile against, so the `.d.ts`
 * is the important output here — the runtime half is a validator and two sinks.
 * Edge-safe: no Node builtins are bundled, nothing is externalised, because the
 * package has no dependencies at all.
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
