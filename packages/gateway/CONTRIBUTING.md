# Contributing to @rebilder/gateway

This file is not in the npm tarball. The README is, and it is written for the
people installing the package.

## Scripts

```sh
pnpm --filter @rebilder/gateway lint        # eslint (flat config)
pnpm --filter @rebilder/gateway typecheck   # tsc --noEmit, including examples/
pnpm --filter @rebilder/gateway test        # vitest
pnpm --filter @rebilder/gateway build       # tsup: ESM, CJS and .d.ts per export
```

## The README and examples/

- Every TypeScript block in `README.md` is a file in `examples/`, byte for byte.
  `tests/readme.test.ts` enforces it in both directions.
- `tsconfig.json` includes `examples/` and maps `@rebilder/gateway` to `src/`,
  so the typecheck compiles every example against the current API.
  `examples/frameworks.d.ts` stubs the framework modules the examples import.
- To change an example, edit the file and paste it into the README.
- Links in the README must be absolute (`https://rebilder.com/docs/...`). npm
  renders the README outside this repository, where relative links break.
- The full documentation is at https://rebilder.com/docs. Its code snippets are
  checked against this README, so maintainers update the docs when a README
  example changes.

## Contracts worth knowing before a change

- **Runtime dependencies** are exactly `@rebilder/agent-detect`,
  `@rebilder/render-md` and `@rebilder/events`. No framework imports anywhere:
  the adapters use web-standard `Request`/`Response` or structural Node types.
- **Latency.** Design target p95 < 50ms of gateway compute. `classifyRequest`
  is header string scans; `handleRequest` makes no network call and no dynamic
  import. Resolvers are the merchant's cost.
- **Failures fall through.** A throwing, hanging or malformed source is a
  no-match; a render failure passes through to HTML without trying the next
  source. Adapters contain gateway errors and never return a 500.
- **Crawlers get HTML.** A known crawler classifies as `crawler` even when it
  sends `Accept: text/markdown`.
- **Negotiation headers.** Pass-through responses get `Vary: Accept` always and
  `Link: rel="alternate"` only when `sources.match` confirms a source
  (`src/core/negotiation.ts` explains why the conditions differ).
- **`@rebilder/protocols` is not a dependency.** The merchant constructs the
  handler and passes it as `config.protocols`, so protocol spec versions ship
  on their own schedule.
- **Compatibility updates.** Signed manifests, cache and expiry behaviour are
  in `src/core/compatibility.ts`; the evaluation runner is in `evaluation/`.
  The user-facing guide is https://rebilder.com/docs/sdk-updates.

## Releasing

Record changes under `## Unreleased` in `CHANGELOG.md`. Maintainers cut
releases from tags. After a release that moves the gateway to a new minor, the
range in `examples/cloudflare-worker/package.json` is widened to admit it.
