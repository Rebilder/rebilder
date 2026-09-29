/**
 * Build config for `@rebilder/mcp-server` — the binary behind
 * `npx -y @rebilder/mcp-server`.
 *
 * Same two-config shape as the CLI and for the same reasons: the executable is
 * a single ESM file with its shebang preserved and no declarations, and the
 * library surface is ESM with types. ESM only because `exports` has no
 * `require` condition, so a CJS build was unreachable weight in the tarball;
 * CommonJS callers on Node 22.12+ can `require()` the ESM entry.
 *
 * `platform: 'node'` is load-bearing rather than cosmetic: the server speaks
 * JSON-RPC over `process.stdin`/`process.stdout` and there is deliberately no
 * HTTP transport, so there is no browser or edge build to keep compatible.
 *
 * The single `bin` entry is named `rebilder-mcp`, not `mcp-server`: `npx -y
 * @rebilder/mcp-server` resolves a package with exactly one bin regardless of
 * its name, and claiming the global command `mcp-server` for ourselves would be
 * rude.
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
