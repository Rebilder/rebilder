# Contributing

Issues and pull requests are welcome. This page explains how changes reach this
repository and how to get yours in.

## How this repository is updated

Rebilder develops these packages in a private repository that also holds our
hosted services. This repository mirrors the SDK part of it. On each release,
and whenever maintainers run a manual sync, the current SDK source is copied
here as one commit named `Sync from rebilder monorepo <commit>`. Paths are the
same in both places, so `packages/gateway/src/index.ts` here is the same file
upstream.

So pull requests are not merged here directly. When we accept one:

1. We apply your commits upstream and keep you as the author.
2. The next sync brings the change back here.
3. We close your pull request with a link to that sync commit.

The files at the root of this repository (this file, the README, the CI
workflow and the workspace manifest) are generated for the mirror. Suggest
changes to them the same way.

## Before you open a pull request

- Open an issue first for anything larger than a bug fix, so we can agree on
  the approach before you write it.
- From the root, run `pnpm install`, `pnpm build`, `pnpm lint`,
  `pnpm typecheck` and `pnpm test`. CI runs the same steps on Node.js 22 and 24.
- Add or update tests. Each package's `CONTRIBUTING.md` lists the contracts its
  tests guard.
- Record user-visible changes under `## Unreleased` in the package's
  `CHANGELOG.md`. Maintainers set versions and publish releases.
- No package has a runtime dependency outside this repository. Keep it that
  way.

## Conventions

Code comments refer to these as project conventions.

- The gateway makes no network calls on its hot path. The design target is
  p95 under 50 ms of compute at the edge.
- Search crawlers always get the canonical HTML. Markdown goes to agents that
  ask for it.
- Renderers inject source values verbatim. They never invent, estimate or
  reword a price, stock state, claim or policy.
- Event schemas are versioned and additive, and consumers accept unknown keys.
- Packages import each other through their published entry points only.
- `@rebilder/gateway` never depends on `@rebilder/protocols`. The merchant
  passes a protocol handler in through `config.protocols`.
- The ARS scorer is a pure function: no clock, randomness or network in the
  scoring path. A patch release never changes a score.
- The CLI and the MCP server send no telemetry.

## License

Contributions are accepted under Apache-2.0, the license of this repository
(section 5 of the license).
