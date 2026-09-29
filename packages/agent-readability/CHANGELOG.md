# @rebilder/agent-readability changelog

Notable changes to `@rebilder/agent-readability`. A patch release never changes a score; a change to the ruleset, the conformance corpus or the page-kind profiles is at least a minor version. Dates are the day each version reached npm.

## Unreleased

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/agent-readability. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.3.0 (2026-09-28)

- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026.
- Smaller package: sourcemaps now ship with the ESM build only. The CommonJS build carried a second copy of the same maps. Unpacked size drops from about 3.0 MB to 1.9 MB. CommonJS code is unchanged.
- `./probe` and `./probe/local` types now resolve under TypeScript's older `node10` module resolution.
- A customer-facing README with a complete `probeStrict()` to `score()` example. Better package description and keywords. This changelog now ships in the package.
- The README explains how this package differs from `@vercel/agent-readability` and links a guide to running both in CI.
- The package description names the standard in full: the Rebilder Agent Readability Spec (ARS).
- No score changes.

## 0.2.0 (2026-08-26)

- Implements ARS 0.2: a new ruleset (scores are not comparable with ARS 0.1), a new evidence-density dimension, and new conformance fixtures.
- Exports the probe's normative pieces from the root so another probe can measure the same thing: `AGENT_ACCEPT`, `BROWSER_ACCEPT`, `ASSET_ACCEPT`, `ARS_ROBOTS_TOKEN`, `parseRobots`, `pathMatches`, `robotsDisallowsScanner` and `utf8Length`.
- The probe identifies itself as `rebilder-ars/0.2`.

## 0.1.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository. No code or score change.

## 0.1.0 (2026-08-10)

First release: the ARS 0.1 scorer (`score`, `recommend`, the ruleset, page-kind profiles, classifier and money parser), the strict server-side probe (`./probe`) and the local probe for private hosts (`./probe/local`, which loads only with `--allow-private`).
