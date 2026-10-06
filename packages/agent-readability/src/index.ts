/**
 * index.ts — the `"."` entry point of `@rebilder/agent-readability`.
 *
 * THIS SURFACE IS A COMMITMENT. The package is published to npm and its users
 * include our own CLI and MCP server, the rebilder.com scanner, and — the whole point
 * of publishing a standard — implementations we do not control. Everything
 * exported here is something we have to keep working across a PATCH release; a
 * name added casually is a name someone imports and we cannot take back.
 *
 * SO THE INTERNALS ARE NOT HERE. The tokenizer (`./html`), the extractor
 * (`./extract`) and the classifier's tables are the *mechanism* of the score, not
 * its interface. They change whenever a real page teaches us something, which is
 * exactly what a MINOR is for; exporting them would freeze the way ARS reads a
 * page into the way ARS is *used*. `classify` and `profileFor` are exported
 * because a consumer legitimately needs to know what kind of page it is holding
 * and what facts that kind is scored against — `tokenizeHtml` is exported for
 * neither reason.
 *
 * PURITY. Nothing reachable from this file touches the network, a clock, a random
 * number or a model. The impure half is a separate entry point, `./probe`, and it
 * is not re-exported here — importing the scorer must never pull a socket into an
 * edge bundle.
 */

/* ── the published contract (§3.9) ────────────────────────────────────────── */

export { ARS_SPEC_VERSION } from './types'
export type {
  ArsAudience,
  ArsAudienceDecision,
  ArsBand,
  ArsBasis,
  ArsCheck,
  ArsCheckEvidence,
  ArsCheckId,
  ArsCostReport,
  ArsDimension,
  ArsDimensionId,
  ArsEvidence,
  ArsFactKind,
  ArsFactObservation,
  ArsFactProfile,
  ArsFlag,
  ArsFlagId,
  ArsGrade,
  ArsHttpCapture,
  ArsOutcome,
  ArsPageKind,
  ArsPolicyReport,
  ArsProbeError,
  ArsProbeRecord,
  ArsRecommendation,
  ArsResult,
  ArsRuleset,
  ArsUnscoredReason,
  ArsVantage,
} from './types'

/* ── the ruleset ──────────────────────────────────────────────────────────── */

/**
 * `DEFAULT_RULESET` is the frozen ARS 0.2 ruleset; `CHECK_META` and
 * `DIMENSION_META` are the published catalogue a UI renders from (label, basis,
 * which dimension a check belongs to) and are not part of the hashed object.
 * The weight totals support methodology views and explanations of the measured
 * and heuristic contributions. Each check preserves its basis label.
 */
export {
  ARS_HEURISTIC_WEIGHT,
  ARS_HEURISTIC_WEIGHT_CEILING,
  ARS_MEASURED_WEIGHT,
  CHECK_META,
  DEFAULT_RULESET,
  DIMENSION_META,
} from './ruleset'
export type { ArsCheckMeta } from './ruleset'

/* ── the scorer ───────────────────────────────────────────────────────────── */

/**
 * `markdownAlternateTarget` (with `declaredMarkdownAlternates` and
 * `isMachineCopy`) is exported so a probe other than `./probe`, such as the
 * browser extension's, fetches the same linked Markdown copy the scorer will
 * look for (ARS 0.3).
 *
 * `score()` is the standard. `bandFor()` is the band lookup every renderer needs
 * (bands headline, integers are secondary). `SUBPOINTS` is the point split inside
 * the checks that score a conjunction rather than a band — published because a
 * second implementation cannot reproduce D1.1 or D6.1 without it.
 *
 * `rulesetHash`, `evidenceHash` and `ARS_CORPUS_HASH` are exported because the
 * determinism guarantee is stated in terms of all three: a number without them is
 * not an ARS score. `sha256Hex` and `canonicalJson` come with them so that a
 * caller can verify a published hash without trusting this package to do it.
 */
export {
  ARS_CORPUS_HASH,
  SUBPOINTS,
  bandFor,
  canonicalJson,
  declaredMarkdownAlternates,
  evidenceHash,
  isMachineCopy,
  markdownAlternateTarget,
  rulesetHash,
  score,
  sha256Hex,
} from './score'

export { recommend } from './recommend'
export type { ArsRecommendationInput } from './recommend'

/* ── page kinds, profiles, money ──────────────────────────────────────────── */

/**
 * `classify` takes pass-1 signals only — it cannot see a profile, which is the
 * wall that keeps classification from depending on the facts it decides how to
 * extract (§3.5). `ArsPass1Signals` is a plain record of `@type` lists, `og:type`,
 * URL path segments and three booleans, so a caller with its own parser can build
 * one and ask "what kind of page is this?" without going through `score()`.
 * `profileFor` is the total map from kind to fact set and byte reference.
 * `parseMoneyText` is exported on its own merits: it is a week of work, it fails
 * closed, and callers outside ARS want it.
 */
export { classify } from './classify'
export type { ArsClassification, ArsPass1Signals } from './classify'
export { PROFILES, profileFor } from './profiles'
export { minorUnitDigits, parseMoneyText } from './parse-money'
export type { Money, MoneyHints, ParsedMoney } from './parse-money'

/* ── writing a probe ──────────────────────────────────────────────────────── */

/**
 * The normative pieces of the fetch half, exported because `./probe` is not the
 * only probe any more and was never meant to be the only one possible.
 *
 * The determinism guarantee this package publishes covers scoring: same
 * evidence in, same result out, in any language. It says nothing about how the
 * evidence was gathered — and yet two of the checks it defines are *about* the
 * gathering. D2.4 compares an agent request against a browser request that
 * differs in exactly one header, so the two `Accept` strings are part of the
 * standard rather than an implementation detail of one client. A second probe
 * that picks its own strings does not measure the same thing.
 *
 * `ARS_ROBOTS_TOKEN` and `robotsDisallowsScanner` are here for the stronger
 * reason: a refusal that one scanner honours and another ignores is not a
 * policy. `utf8Length` is the normative body measurement behind D3.2 (the
 * decoded UTF-8 byte length, not `Content-Length`), and `parseRobots` /
 * `pathMatches` are the matcher both the gate and the scorer use, so they
 * cannot disagree about what a pattern means.
 *
 * These are additive, and they are on the ROOT on purpose: a browser cannot
 * import `./probe`, which carries a connection limiter and DNS-level SSRF
 * guards that mean nothing in a page context. The first consumer is our own
 * extension; the second is whoever reimplements this in Go.
 */
export { AGENT_ACCEPT, ASSET_ACCEPT, BROWSER_ACCEPT } from './probe/headers'
export { ARS_ROBOTS_TOKEN, robotsDisallowsScanner } from './robots-policy'
export { parseRobots, pathMatches, utf8Length } from './extract'
