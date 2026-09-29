# Contributing to rebilder (the CLI)

This file is not in the npm tarball.

## Scripts

```sh
pnpm --filter rebilder lint
pnpm --filter rebilder typecheck
pnpm --filter rebilder test
pnpm --filter rebilder build
```

## README example blocks are generated

Every `console` block in `README.md` is generated from a fixture in
`packages/agent-readability/conformance/`, labelled with its fixture id, and
`tests/readme.test.ts` regenerates and compares each one on every run. A
hand-edited block fails the build. This exists because an earlier draft shipped
a mocked `47/100` alongside "+20 pts, D → B", which its own bands made
impossible, and nothing caught it.

Regenerate with:

```sh
REBILDER_README_UPDATE=1 pnpm --filter rebilder test
```

It rewrites the blocks and then fails the run, so an update can never be
mistaken for a pass. Read the diff before committing it.

## Contracts

- **Zero telemetry.** `tests/telemetry.test.ts` proves the package has no
  socket, no `fetch` call and exactly one runtime dependency. The only
  rebilder.com URLs allowed in `src/` are the badge embed and printed links to
  the spec, the crawler policy and `/docs/adapters`.
- **Exit codes are a stable contract** and never renumbered.
- **`rebilder init` recipes** mirror the adapter guides under
  https://rebilder.com/docs/adapters. Maintainers update the guides when a
  recipe changes.

## Publishing

Workspace dependencies are rewritten, not bundled, at pack time. A
`workspace:*` range that pnpm does not rewrite ships as an uninstallable
manifest, which is why releases go out through the maintainers' tagged release
workflow, never a bare `npm publish`. Record changes under `## Unreleased` in
`CHANGELOG.md`.
