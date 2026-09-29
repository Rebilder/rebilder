import path from 'node:path'
import { defineConfig } from 'vitest/config'

const src = path.resolve(__dirname, 'src')

export default defineConfig({
  // The README examples import `@rebilder/gateway` by its public name. Resolve
  // it to the source here, as tsconfig.json `paths` does for the typecheck, so
  // tests/readme.test.ts can run the examples without a build.
  resolve: {
    alias: [
      {
        find: /^@rebilder\/gateway\/(next|node|edge|shopify|fetch)$/,
        replacement: `${src}/adapters/$1/index.ts`,
      },
      { find: /^@rebilder\/gateway$/, replacement: `${src}/index.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules'],
  },
})
