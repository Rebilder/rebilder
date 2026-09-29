# Contributing to @rebilder/render-md

This file is not in the npm tarball.

## Scripts

```sh
pnpm --filter @rebilder/render-md lint
pnpm --filter @rebilder/render-md typecheck
pnpm --filter @rebilder/render-md test
pnpm --filter @rebilder/render-md build
```

## The tests that guard the contract

- `commerce-frozen.test.ts` pins the three commerce renderers byte-exactly with
  **inline string literals**, not snapshots: `vitest -u` can silently regenerate
  a snapshot, it cannot regenerate a string literal. A change to that file is a
  deliberate output change, never a mechanical update. The same applies to
  `tests/__snapshots__/`: review any output change against the renderer
  contract before updating expected values.
- `documents-integrity.test.ts` is **structural, not a corpus scan**. A bare
  number scan is not a validator: a `number` fact renders through
  `String(value)`, so once a `3` is in the output any `3` passes a scan,
  including a fabricated one. The test instead pins every fact to the exact
  line `- **<label>:** <expected>`, with `expected` computed independently from
  the fixed label maps, and asserts that the output minus the scaffolding
  whitelist is a token-for-token **subsequence** of the source strings. The
  whitelist is restated as literals there rather than imported, so new
  renderer-authored text cannot whitelist itself.
- `documents-access.test.ts` proves the access gate holds at every budget.
- `documents-budget.test.ts` asserts truncation ordering over a sweep of budgets.
- `integrity.test.ts` keeps the commerce price-token scan.
- `readme.test.ts` checks the README's example output against the renderer.

## Extending the source model

Use a profile when the existing fact types express the content clearly. Add a
source type or renderer when it improves machine-readable structure, protocol
support or a customer workflow. Preserve compatibility and validate the new
output. Every renderer-authored string must be added to the scaffolding
whitelist in the README and in `documents-integrity.test.ts`.

Compatibility profiles and SDK presentation updates are described at
https://rebilder.com/docs/sdk-updates.

## Releasing

Record changes under `## Unreleased` in `CHANGELOG.md`. Maintainers cut
releases from tags. `renderProductJsonLd` also feeds the agent-commerce feeds
in `@rebilder/protocols`, which is not yet published, so maintainers review
JSON-LD changes against it before release.
