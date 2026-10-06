# Contributing to @rebilder/agent-readability

This file and `conformance/` are not in the npm tarball. The README is, and it
is written for people installing the package.

- **Purity is enforced at build time.** An ESLint `no-restricted-globals` /
  `no-restricted-properties` rule over `src/` (except `src/probe/`) bans `Date`,
  `Math.random`, `fetch` and `performance`. Nothing that needs a clock or a
  socket may move out of `src/probe/`.
- **A patch release may not change a score.** The release workflow's ARS patch
  gate diffs `conformance/**` (fixture README prose excepted), `src/ruleset.ts`
  and `packages/profiles/profiles/**` between tags and fails a patch that moved
  any of them.
- **The page-kind profiles exist twice**, here in `src/profiles.ts` and as JSON
  in `packages/profiles/profiles/`. `tests/profiles-parity.test.ts` requires
  them to agree.
- **The README example** is `examples/score-a-page.ts`, compiled by the
  package typecheck and checked verbatim by `tests/readme.test.ts`.

## Modules in this package

### `src/types.ts` — the published contract

Transcribed from design §3.9. These types are the schema of `expected.json` in the conformance corpus, which is what a second implementation in Go or Python has to reproduce. Document added fields and their compatibility so other implementations can adopt them.

### `src/ruleset.ts` — `DEFAULT_RULESET`

Every number a second implementation needs, and nothing that varies between runs: check weights (22 checks summing to 100), the §3.6 scoring bands, crawler audience tokens, the D5.2 required-property table, the action lexicon, the A–F grade bands, and the three probe limits that are inputs to the score (2 MiB body cap, 3 redirects, 5 000ms timeout — two implementations with different caps produce different scores, so they are hashed with everything else).

`rulesetHash` is the SHA-256 of the RFC 8785 canonical JSON of this object. **Editing a number here is a spec version change, not a code change**: per §3.1, any edit that moves a conformance `expected.json` is at minimum a MINOR, and MINOR means scores stop being comparable and every published surface re-scores in a batch.

### `src/profiles.ts` — the eight page-kind profiles

`product`, `collection`, `article`, `place`, `service`, `faq`, `document`, `unknown`. A closed set; every kind has a complete profile, and the mapping is total by construction (`PROFILE_BY_KIND` is a total `Record`, so a missing profile is a compile error). Core facts score at full weight, extended facts at ¼ credit — one definition, applied everywhere. `unknown` is not an easy exit: it still scores D5.2 against "any recognised schema.org type present".

### `src/html.ts` — a tolerant, non-executing tokenizer

Hand-rolled, and that is a normative decision rather than a preference: **a third-party parser version is an unversioned input to a deterministic score.** A dependency that changes how a malformed `<div` is recovered would change scores on a `pnpm update`, with no ARS version bump and no conformance diff. The recovery rules here _are_ the spec.

- Byte offsets are **UTF-8 byte offsets**, not string indices, because `ArsHttpCapture.bytes` is defined as the decoded UTF-8 byte length and D4 scores offsets against it. One `€` before the price is enough to make the two disagree.
- Counted text follows the §3.6 rule exactly: everything except `<script>`, `<style>`, `<template>`, `hidden`, and inline `style="display:none"`. **No CSS resolution** — a cascade engine would not be deterministic across implementations, so a class that hides an element in a stylesheet does not hide it here.
- `tokenizeHtml` **never throws**, for any input. A scanner that can be crashed by the page it is scanning is a denial-of-service endpoint.

One reading decision is flagged in the file header: JSON-LD script contents are surfaced separately (`doc.jsonLd`) and are **not** counted as visible text, because the other reading would trivially satisfy both D5.3 and the definition of "corroborated".

### `src/parse-money.ts` — text → `Money`, or `null`

Real work, budgeted as such. `@rebilder/render-md`'s `money.ts` only _formats_ an already-structured `Money`; it cannot parse text, and the claim that it could hid the largest single piece of extraction work in the program.

**Fails closed.** Ambiguous input returns `null`, and a `null` price is simply not a fact — it costs coverage points and nothing else. A _wrong_ price would be published on a scanner page as truth and would make a parity check accuse a merchant of a divergence they did not commit. Supported: leading/trailing symbols, ISO code prefix/suffix, comma and period as both group and decimal separator (disambiguated by position and by the minor-unit width of the resolved currency), space/NBSP/apostrophe group separators, zero-decimal currencies, ranges and qualifiers (→ the lower bound, `qualified: true`, which excludes them from the D2.4 parity comparison).

`Money` is declared here rather than imported from `@rebilder/render-md`. The duplication is deliberate: the package-graph check forbids that dependency edge in both directions, because the two packages point in opposite directions — gateway/render-md turn a source of truth into output; the scorer turns a response into a judgment.

### `src/score.ts` — the scoring engine

`score(evidence, ruleset = DEFAULT_RULESET) → ArsResult`. Twenty-two checks, seven dimensions, 100 points, one pure function.

**Integer arithmetic only.** Every number is produced by exact integer division (`(n − n % d) / d`, which never rounds, unlike `Math.floor(n / d)` on a double quotient) and half-up rounding via `(n + d/2) / d`. `Math.round`, `0.25 ×` and `0.5 ×` appear nowhere in the scoring path. Two implementations that disagree in the third decimal disagree about grades at the band boundary, and the boundaries are what the product publishes.

**Which representation scores what.** D3 (coverage) and D4 (position) score the **agent** representation, because ARS measures what a caller actually receives — a merchant whose Markdown omits `availability` loses coverage even though the HTML declares it. D1.3 (render independence) and D5 (structured data) score the representation that carries a **document**. Corroboration crosses the two: a price stated in the negotiated Markdown _and_ in the HTML's JSON-LD is observed in two sources, which is the only reason a correct gateway install can reach an A.

**Two gates, both pointing the safe way.** D2.3 (`Vary: Accept`) scores 0 unless the page negotiates, and D2.4 (substance parity) scores 0 unless D2.1 earned points, from negotiation or (ARS 0.3) from a linked Markdown copy that loaded — a **measured** check gating others. That is what makes the published ceiling provable: no content negotiation loses 9 + 3 + 3 → **max 85 → capped at B**. **An A requires a machine representation, and as of 0.2 it no longer requires structured data**: D5 fell from 15 points to 6, so a page with none can still reach 94. The forbidden direction — a heuristic that can zero measured points — appears nowhere, and fixture `053` re-derives the heuristic-controlled weight (37) from the gate graph to prove it.

**Comparison is asymmetric, deliberately.** D2.4 and D5.3 ask whether the value one side would _publish_ (its lowest-offset unqualified observation, the same choice the published fact set makes) appears anywhere among the values the other side _stated_. Requiring the two headline values to be equal produces false accusations on ordinary pages — the demo product page in fixtures 001 and 002 names a backordered variant above the line that says the product is in stock, and both statements are true. Accepting any shared value lets a real divergence hide behind an incidental match, because "Free shipping over $50" appears in both representations. The asymmetric rule catches the second and not the first, which is the conservative direction: a missed divergence costs a merchant nothing, and a false one is published next to their name.

**Gate order for non-grades**, and none of them is an F: `robots-disallow-scanner` (a statement about our own conduct, and only `vantage: 'public'` is gated — an owner consents for their own origin) → `robots-unavailable` → `opt-out` (the site's decision, reported before any failure of ours) → fetch failures → `evidence-incomplete` → `truncated-evidence`. A non-grade still carries all seven dimensions with their weights, every check at `earned: 0` with an evidence line naming the reason, and the policy and cost reports — but no sub-scores, because publishing those next to `score: null` would be scoring by another name.

**ARS 0.3 implementation notes:**

- **A linked Markdown copy is fetched once and verified.** When the agent probe gets HTML and the page declares a Markdown alternate at another same-origin address, the probe fetches it (`probes.markdownAlternate`). `markdownAlternateTarget` picks the URL for the probe and the scorer alike, so a bundle cannot credit a copy the page never declared. A working copy earns 6 of D2.1's 9; a broken one zeroes D2.2 as well.

- **D5.2 walks JSON-LD only.** Microdata and RDFa satisfy D5.1 (present and parsing) but are not traversed for required properties, so a microdata-only page scores 2/6 on D5 rather than the full 6.
- **A declared paywall is flagged, not exempted.** `isAccessibleForFree: false`, HTTP 402 and `WWW-Authenticate` raise the `paywalled` flag; the §3.8 exemption of the gated part from coverage and position needs `hasPart` + `cssSelector` support in the extractor and is not implemented.
- **`corpusHash` identifies the corpus version.** `ARS_CORPUS_HASH` is the SHA-256 of `ars-0.3-corpus-unfrozen`, not a digest of fixture contents. A corpus-content digest replaces this marker at corpus freeze in a MINOR release.
- **`SUBPOINTS` and the classification tables are not covered by `rulesetHash`.** §3.9's `ArsRuleset` has no field for either. They are published (exported, and printed in the spec) and the corpus is what pins them.
- **SHA-256 is implemented in this file.** `node:crypto` would make the package Node-only and browser and edge callers import the root entry point; `crypto.subtle` is async and `score()` is not; the current implementation keeps this path synchronous and portable. It is checked against the FIPS 180-4 vectors in `tests/score.test.ts`.

### `src/recommend.ts` — what to fix, in what order, and what it is worth

`recommend({ dimensions, score })` computes remedies over a dependency DAG. A recommendation's `pointsAvailable` counts only the checks not already claimed by a higher-ranked one, **plus** the checks it uniquely unlocks — D2.1 owns D2.3 and D2.4 while it is at zero, and only while it is at zero. Sums are capped per dimension, output order is rank order, and a recommendation may claim its unlocks only if it also closes something itself. Every number is a real gap between `earned` and `weight`; a page at 100 gets an empty list rather than a list of platitudes. `Σ pointsAvailable ≤ 100 − score` is asserted over the whole corpus.

### `src/index.ts` — the published surface

`score`, `recommend`, `bandFor`, the three hashes, `DEFAULT_RULESET`, `CHECK_META`, `DIMENSION_META`, `SUBPOINTS`, the profiles, `classify`, `parseMoneyText`, and every type in §3.9. **The tokenizer and the extractor are deliberately not exported.** They are the mechanism of the score, not its interface: they change whenever a real page teaches us something, which is what a MINOR is for, and exporting them would freeze the way ARS reads a page into the way ARS is used.

## Boundaries

```
cli ──┐
      ├──► agent-readability (. pure, ./probe server-only)
mcp ──┘
gateway ──X──► agent-readability     (forbidden, BOTH directions)
agent-readability ──X──► gateway
```

Enforced by a package-graph check, which also forbids deep imports: `.`, `./probe` and `./probe/local` are the entire public API. Code that must never fetch an arbitrary host imports `.` only; `./probe` is for server-side callers that are allowed to reach the network.

## Development

```bash
pnpm --filter @rebilder/agent-readability typecheck
pnpm --filter @rebilder/agent-readability lint      # includes the purity rule
pnpm --filter @rebilder/agent-readability test      # includes the conformance corpus
```

The corpus also runs on its own from the repository root: `pnpm ars:conform`. CI runs it on every change.

## The conformance corpus

`conformance/NNN-name/` and its runner (`tests/conformance.test.ts`) are the language-neutral standard. The spec describes the score in prose; the corpus says what the prose means, in JSON, in a form a Go or Python implementation can consume without reading TypeScript.

```
conformance/NNN-name/
  evidence.json   the INPUT — an ArsEvidence bundle, response bodies included
  expected.json   SPEC-DERIVABLE fields only. A second implementation must reproduce this.
  identity.json   rulesetHash / corpusHash / evidenceHash — properties of OUR artifact.
                  A second implementation is explicitly NOT required to match them, and
                  that split is what makes independent certification possible at all.
  README.md       one paragraph on what the fixture proves
```

**The runner globs.** Every directory under `conformance/` is picked up with no edit to the runner — fixtures land from several people at once, and a hand-maintained list is a list that silently skips the one someone forgot to register. A directory with no `evidence.json`, no `expected.json`, no `README.md` or unparseable JSON is an **error**, never a skip.

**What `expected.json` pins**, and what it deliberately does not: every number and every identifier — `earned` per check and per dimension, grade, score, band label, page kind and confidence, the fact set, the flags raised, the policy decisions, the cost report, and the recommendation arithmetic. Not the three hashes (they are `identity.json`'s job), and not a single human-facing string — check labels, evidence lines, flag messages, recommendation copy. Those are ours to reword in a PATCH, and a corpus that pinned them would turn copy edits into spec changes.

**`corpusHash` is recorded but not asserted per fixture.** It is a digest over the whole corpus, so it moves every time anyone adds a fixture; pinning it while the corpus is open would make every new fixture break every old one. `rulesetHash` and `evidenceHash` are asserted, because they are properties of inputs that do not move.

**Regenerating:**

```bash
ARS_CONFORM_UPDATE=1 pnpm --filter @rebilder/agent-readability test
```

writes `expected.json` and `identity.json` from the current implementation **and then fails the run**, so an update can never be mistaken for a pass. Read the diff before committing it: blessing output you have not checked is how a corpus stops encoding the spec and starts encoding the bug.

### The golden pair

`001-pdp-gateway-md` and `002-pdp-raw-html` carry the **same 91,226-byte HTML body**, a real captured product page, and differ only in what the agent probe receives and in the response headers, which is exactly the one variable §3.3 allows. The same page scores **59 (D)** raw and **93 (A)** with the gateway installed. 001 was captured before `@rebilder/gateway` declared `Link: rel="alternate"` and a canonical on its Markdown response; the gateway sends both today, so an install scanned now earns those 4 points. `064` and `065` reuse the same body to pin the ARS 0.3 linked-copy rules.

### Property fixtures 050–059

Design §3.10 names ten properties. Two need an evidence bundle to be about anything and are **corpus directories**; the other eight are properties of the ruleset, the profiles, the parsers or the build, and live in `tests/score.test.ts` as `describe('05N …')` blocks. Every id appears in exactly one of the two places:

| id                             | where                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `050-byte-identical-replay`    | **directory** (+ corpus-wide replay assertion in the runner, and the volatile-header assertions in `score.test.ts`) |
| `051-multi-value-headers`      | **directory**                                                                                                       |
| `052-weights-sum-100…`         | test                                                                                                                |
| `053-heuristic-controlled…`    | test                                                                                                                |
| `054-band-boundaries`          | test                                                                                                                |
| `055-no-network`               | test (asserts the ESLint gate, which is the real check, plus a source scan)                                         |
| `056-no-clock`                 | test (same shape)                                                                                                   |
| `057-tokenizer-fuzz`           | test (seeded LCG — a fuzz corpus that differs between machines teaches nobody anything)                             |
| `058-profiles-total-and-typed` | test                                                                                                                |
| `059-money-parser`             | test                                                                                                                |
