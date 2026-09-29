# Contributing to @rebilder/agent-detect

This file and `fixtures/` are not in the npm tarball. The README is, and it is
written for people installing the package.

## Scripts

```sh
pnpm --filter @rebilder/agent-detect lint        # eslint (flat config)
pnpm --filter @rebilder/agent-detect typecheck   # tsc --noEmit (strict)
pnpm --filter @rebilder/agent-detect test        # vitest (fixture-driven + unit)
```

## Detection fixtures

`fixtures/*.json` holds detection samples. `tests/fixtures.test.ts` loads every
file and asserts every sample, so adding a fixture adds a regression test.

```json
{
  "name": "claude-code",
  "description": "…",
  "samples": [
    { "headers": { "...": "..." }, "url": "…", "expected": { "kind": "agent", "platform": "claude-code", "acceptsMarkdown": true } }
  ]
}
```

- Every newly observed agent gets a fixture first, then a pattern.
- Keep each sample's provenance in the `description`: captured from traffic,
  transcribed from the vendor's documentation (cite the URL and the date), or
  synthetic. Never present a synthetic or transcribed sample as observed traffic.
- Every User-Agent pattern in `src/detect.ts` cites the vendor documentation it
  came from in a comment next to it. Do not add a pattern from a third-party
  list alone.

## When you change a detection table

- Crawler before agent: misclassifying a crawler as an agent serves it
  markdown, which is the cloaking pattern. When a token is ambiguous, classify
  it as a crawler.
- Keep the order of the `CRAWLER_UA`, `AGENT_UA` and
  `SIGNATURE_AGENT_PLATFORMS` tables stable and add entries in place. The
  Rebilder WordPress plugin carries a PHP port of these tables that must stay in
  parity, and maintainers port an accepted change entry by entry.

## Not built yet

- Key-directory refresh tooling (an offline snapshot script).
- Verified-bot IP corroboration for crawlers.

## Releasing

Record changes under `## Unreleased` in `CHANGELOG.md`. Maintainers cut
releases from tags.
