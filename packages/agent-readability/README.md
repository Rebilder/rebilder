# @rebilder/agent-readability

Score how well AI agents can read a web page. This is the reference implementation of the [Rebilder Agent Readability Spec](https://rebilder.com/spec/ars) (ARS 0.3): it checks whether the facts an agent needs for that kind of page are present, findable and cheap to read, and ranks the fixes.

The scorer is a pure, deterministic function with no dependencies: no network, no clock, no randomness, no model. A separate entry point fetches live pages safely.

**Comparing it with `@vercel/agent-readability`?** Vercel's package detects AI agents, routes them to markdown through framework middleware, and audits a whole site against a Vercel checklist that it also calls the Agent Readability Spec. This package scores one URL at a time against Rebilder's ARS, a separate standard with fixed weights, page-kind fact checks and a public conformance corpus. It does not serve anything to agents; [`@rebilder/gateway`](https://www.npmjs.com/package/@rebilder/gateway) does that. You can run both, for example [Vercel's audit and `rebilder check` in the same CI job](https://rebilder.com/docs/vercel-agent-readability).

## Install

```sh
npm install @rebilder/agent-readability
```

Want a score without writing code? Run `npx rebilder check <url>`, or give your AI assistant the `@rebilder/mcp-server` tools.

## Score a live page

```ts
import { score } from '@rebilder/agent-readability'
import { probeStrict, strictPolicyForRun } from '@rebilder/agent-readability/probe'

// 1. Fetch the evidence: the page as an agent and as a browser, plus robots.txt,
//    llms.txt, /.well-known/ucp and any Markdown copy the page links to.
//    Public https hosts only.
const outcome = await probeStrict('https://example.com/products/trail-pack', strictPolicyForRun())
if (!outcome.ok) throw new Error(`${outcome.rejection}: ${outcome.detail}`)

// 2. Score it. Pure and deterministic: the same evidence always gives the same result.
const result = score(outcome.evidence)

console.log(result.grade, result.score) // e.g. 'B' 81; null for a page that could not be graded
for (const fix of result.recommendations) {
  console.log(`+${fix.pointsAvailable}  ${fix.title}`)
}
```

`score()` takes an `ArsEvidence` bundle and returns an `ArsResult`: the grade (`A` to `F`) and score (0 to 100), seven dimensions with every check and its evidence, whether each check is measured or heuristic, the page kind, the facts found, the context cost, and ranked recommendations whose points never add up to more than the page is missing.

## Entry points

| Import | What it is | Where it runs |
|---|---|---|
| `@rebilder/agent-readability` | `score()`, `recommend()`, the ruleset, the page-kind profiles, the classifier, the money parser and every published type | Anywhere, including browsers and edge runtimes |
| `@rebilder/agent-readability/probe` | `probeStrict()`: fetches evidence from a public https origin. DNS-validated and pinned against private addresses, 2 MiB streamed body cap, 3 redirects, 5 second timeout, robots.txt read first, a politeness limiter | Node.js servers |
| `@rebilder/agent-readability/probe/local` | `probeLocal()`: also allows private hosts and plain http, for checking your own staging site | A terminal only. It refuses to load unless the process was started with `--allow-private`, and always in a hosted runtime |

The probe identifies itself as `rebilder-ars/0.3 (+https://rebilder.com/bots)`, never as another company's crawler, and obeys a robots.txt group that disallows `rebilder-ars`.

## What the score measures

ARS measures format and retrievability. It does not measure whether the facts are true, or whether any assistant cites the page.

- **Fixed weights, 100 points, the same for every page kind.** What varies by kind (product, place, service, article, FAQ, collection, document) is which facts count and how many bytes a page of that kind reasonably costs.
- **63 points are measured and 37 are heuristic**, and every check reports which it is.
- **Two outcomes are not grades.** `outcome.kind` is `opt-out` when the site's robots.txt deliberately opts out, which is a choice, not a failure. It is `unscored` when there was nothing to grade: blocked at the edge, unreachable, a non-2xx response, too many redirects, robots.txt unavailable or disallowing the scanner, or incomplete evidence. Neither is an F.
- **Blocking training crawlers while allowing assistants scores the same as a fully open site.**
- **Reproducible.** For a given `evidenceHash`, `rulesetHash` and `corpusHash`, `score()` returns a byte-identical result in any conforming implementation. A number without those three hashes is not an ARS score.

The specification, the scoring bands and the conformance corpus are published at [rebilder.com/spec/ars](https://rebilder.com/spec/ars), so the score can be implemented in any language. Page-kind fact lists are also published on their own as [`@rebilder/profiles`](https://www.npmjs.com/package/@rebilder/profiles).

## Versioning

A patch release never changes a score. If the ruleset, the conformance corpus or the page-kind profiles change, the release is at least a minor version. `ARS_SPEC_VERSION` is the specification version and moves on its own schedule.

Release notes are in `CHANGELOG.md` in this package. Licensed under Apache-2.0. Source, issues and pull requests: [GitHub](https://github.com/rebilder/rebilder/tree/main/packages/agent-readability).
