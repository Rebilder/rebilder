# Contributing to @rebilder/events

This file is not in the npm tarball. The README is, and it is written for
people installing the package.

## Scripts

```sh
pnpm --filter @rebilder/events lint
pnpm --filter @rebilder/events typecheck
pnpm --filter @rebilder/events test
pnpm --filter @rebilder/events build
```

## Who else reads these types

- The hosted ingest endpoint (`POST https://api.rebilder.com/v1/events`)
  implements the wire protocol and accepts only the closed unions declared in
  `src/types.ts`. `validateEventV0` rejects at the trust boundary for the same
  reason. A new member of a closed union therefore ships in the ingest service
  first; maintainers coordinate that when they apply the change.
- The Rebilder Tag (`tag.js`, served from rebilder.com) sends `ClientEventV0`.
- This package grants no access to anyone's data and authorizes no new data
  use. It defines shapes and delivers them where the site owner points it.

## Schema changes

- Versioned and additive. A new field extends the version or starts a new one
  (`RebilderEventV1`). Removing a field needs a migration note in
  `CHANGELOG.md`.
- Consumers must accept unknown keys, so validation allows them at every level.
- The README's snippets also appear on https://rebilder.com/docs/events, and
  maintainers keep the two in step.

## Releasing

Record changes under `## Unreleased` in `CHANGELOG.md`. Maintainers cut
releases from tags.
