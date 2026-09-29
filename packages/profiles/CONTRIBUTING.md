# Contributing to @rebilder/profiles

This file is not in the npm tarball.

## Scripts

```sh
pnpm --filter @rebilder/profiles typecheck
pnpm --filter @rebilder/profiles lint
pnpm --filter @rebilder/profiles test
```

## Keeping the vocabulary and the score together

- `profiles/*.json` is the published vocabulary. The ARS scorer keeps the same
  fact sets in `packages/agent-readability/src/profiles.ts`.
- `tests/profiles.test.ts` here compares the JSON with the design's page-kind
  table, transcribed by hand. `packages/agent-readability/tests/profiles-parity.test.ts`
  compares the JSON with the scorer's profiles directly. Change both files in
  the same commit.
- Editing a profile edits the score, so the release workflow's ARS patch gate
  treats `profiles/**` as score-defining: a change here cannot ship as a patch
  of `@rebilder/agent-readability`.
- A new fact name must be added to the `FactName` union in `src/types.ts` and to
  the scorer's `ArsFactKind`.

## Releasing

Record changes under `## Unreleased` in `CHANGELOG.md`. Removing or renaming a
fact is a major version of this package. Maintainers cut releases from tags.
