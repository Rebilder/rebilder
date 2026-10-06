/**
 * ruleset.ts — `DEFAULT_RULESET`, the frozen ARS 0.3 ruleset.
 *
 * WHAT THIS FILE IS. Every number a second implementation needs in order to
 * reproduce a score, and nothing that varies between runs. `rulesetHash()` is
 * the SHA-256 of the RFC 8785 canonical JSON of this object, it is printed on
 * every result, and the determinism guarantee is stated in terms of it: a
 * number without `rulesetHash`, `corpusHash` and `evidenceHash` is not an ARS
 * score. That makes this file a published artifact, not configuration.
 *
 * CONSEQUENCE: editing a number here is a spec version change, not a code
 * change. Per §3.1, any edit that moves a conformance `expected.json` is at
 * minimum a MINOR — and MINOR means scores stop being comparable and every
 * published surface re-scores in a batch. The CI gate on PATCH releases exists
 * precisely so that "just tweaking a threshold" cannot happen quietly.
 *
 * WHY THE BODY CAP, REDIRECT LIMIT AND TIMEOUT LIVE HERE rather than in the
 * probe: two implementations with different caps produce different scores. A
 * 3 MiB cap turns a `truncated-evidence` non-grade into an F, and a 10s timeout
 * scores pages a 5s timeout reports as unreachable. They are inputs to the
 * score, so they are inputs to the hash.
 *
 * SHAPE. Everything is `as const satisfies <contract>`: the `satisfies` clause
 * proves the object matches the published type (and, for the tables keyed by
 * `ArsCheckId` / `ArsPageKind`, that it is TOTAL), while `as const` keeps the
 * literal types so callers get `number`, not `number | undefined`, from a known
 * key. `deepFreeze` then makes it immutable at runtime as well — a mutated
 * shared ruleset would corrupt every subsequent score in the process, silently.
 */

import { PROFILES } from './profiles'
import type {
  ArsBand,
  ArsBasis,
  ArsCheckId,
  ArsDimensionId,
  ArsPageKind,
  ArsRuleset,
} from './types'

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

/**
 * Recursively freezes a plain data structure. Used once, on `DEFAULT_RULESET`.
 * `as const` is a compile-time guarantee only; this is the runtime half.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

// ---------------------------------------------------------------------------
// Check weights — the §3.4 table, row for row
// ---------------------------------------------------------------------------

/**
 * Check id → points. Sums to exactly 100 across 22 checks.
 *
 * NO CONDITIONAL WEIGHTS. NO REDISTRIBUTION. NO HEURISTIC GATES OVER MEASURED
 * POINTS. Redistribution is a gaming vector (make the dimension you are bad at
 * inapplicable and the rest inflate), and a heuristic that can zero measured
 * points makes those points heuristic. So D2.4 and D5.3 are scored checks, not
 * gates: a parity failure loses its own 3 points and raises a `warn`, and does
 * not touch D2's other measured points. That is what makes "measured 63 /
 * heuristic 37" an honest figure rather than a presentational one, and fixture
 * `053` re-derives the heuristic-*controlled* weight to prove it.
 *
 * `satisfies Record<ArsCheckId, number>` makes the table total: a check id
 * added to the union without a weight here is a compile error.
 */
const WEIGHTS = {
  // D1 Retrievability — 28
  'retrievability.reachable': 11,
  'retrievability.robots-policy': 10,
  'retrievability.render-independence': 7,
  // D2 Machine representation — 18
  'machine-representation.negotiated-response': 9,
  'machine-representation.declared-alternates': 3,
  'machine-representation.vary-accept': 3,
  'machine-representation.substance-parity': 3,
  // D3 Fact coverage — 20
  'fact-coverage.core-facts': 14,
  'fact-coverage.context-cost': 6,
  // D4 Fact position — 10
  'fact-position.first-core-fact-offset': 5,
  'fact-position.front-window': 5,
  // D5 Structured data — 6
  'structured-data.present': 2,
  'structured-data.required-properties': 3,
  'structured-data.text-agreement': 1,
  // D6 Contract & discovery — 10
  'contract-discovery.canonical': 4,
  'contract-discovery.cache-validators': 2,
  'contract-discovery.llms-txt': 1,
  'contract-discovery.sitemap': 1,
  'contract-discovery.machine-endpoint': 2,
  // D7 Evidence density — 8
  'evidence-density.quantities': 4,
  'evidence-density.definitions': 2,
  'evidence-density.comparisons': 2,
} as const satisfies Record<ArsCheckId, number>

/** Descriptive metadata per check: which dimension it belongs to, its published label, its basis. */
export interface ArsCheckMeta {
  dimension: ArsDimensionId
  label: string
  basis: ArsBasis
}

/**
 * The published catalogue of checks. `dimension` is redundant with the check id
 * prefix by construction — the id shape `<dimension>.<check>` is normative — and
 * is spelled out anyway so consumers never parse an id string to group results.
 *
 * `basis` is spec data (it appears in every `expected.json` and is printed next
 * to every check in the UI) but it is not part of `ArsRuleset` in §3.9, so it is
 * exported here rather than folded into the hashed object. A second
 * implementation reads it from the published §3.4 table.
 */
export const CHECK_META = {
  'retrievability.reachable': {
    dimension: 'retrievability',
    label: 'Reachable on the agent path',
    basis: 'measured',
  },
  'retrievability.robots-policy': {
    dimension: 'retrievability',
    label: 'Robots policy for assistants',
    basis: 'measured',
  },
  'retrievability.render-independence': {
    dimension: 'retrievability',
    label: 'Core facts present without JavaScript',
    basis: 'heuristic',
  },
  'machine-representation.negotiated-response': {
    dimension: 'machine-representation',
    label: 'Machine representation on Accept negotiation',
    basis: 'measured',
  },
  'machine-representation.declared-alternates': {
    dimension: 'machine-representation',
    label: 'Declared alternate representations',
    basis: 'measured',
  },
  'machine-representation.vary-accept': {
    dimension: 'machine-representation',
    label: 'Vary: Accept declared correctly',
    basis: 'measured',
  },
  'machine-representation.substance-parity': {
    dimension: 'machine-representation',
    label: 'Same substance across representations',
    basis: 'heuristic',
  },
  'fact-coverage.core-facts': {
    dimension: 'fact-coverage',
    label: 'Core facts for this page kind',
    basis: 'heuristic',
  },
  'fact-coverage.context-cost': {
    dimension: 'fact-coverage',
    label: 'Context cost relative to this page kind',
    basis: 'measured',
  },
  'fact-position.first-core-fact-offset': {
    dimension: 'fact-position',
    label: 'Byte offset of the first core fact',
    basis: 'heuristic',
  },
  'fact-position.front-window': {
    dimension: 'fact-position',
    label: 'Core facts inside the front window',
    basis: 'heuristic',
  },
  'structured-data.present': {
    dimension: 'structured-data',
    label: 'Structured data present and parsing',
    basis: 'measured',
  },
  'structured-data.required-properties': {
    dimension: 'structured-data',
    label: 'Recognised type with its required properties',
    basis: 'measured',
  },
  'structured-data.text-agreement': {
    dimension: 'structured-data',
    label: 'Structured data agrees with visible text',
    basis: 'heuristic',
  },
  'contract-discovery.canonical': {
    dimension: 'contract-discovery',
    label: 'Canonical URL present and self-consistent',
    basis: 'measured',
  },
  'contract-discovery.cache-validators': {
    dimension: 'contract-discovery',
    label: 'Cache validators',
    basis: 'measured',
  },
  'contract-discovery.llms-txt': {
    dimension: 'contract-discovery',
    label: 'llms.txt present and spec-shaped',
    basis: 'measured',
  },
  'contract-discovery.sitemap': {
    dimension: 'contract-discovery',
    label: 'Sitemap declared in robots.txt',
    basis: 'measured',
  },
  'contract-discovery.machine-endpoint': {
    dimension: 'contract-discovery',
    label: 'Declared machine endpoint',
    basis: 'measured',
  },
  'evidence-density.quantities': {
    dimension: 'evidence-density',
    label: 'Quantities an answer can quote',
    basis: 'measured',
  },
  'evidence-density.definitions': {
    dimension: 'evidence-density',
    label: 'Labelled term and value pairs',
    basis: 'heuristic',
  },
  'evidence-density.comparisons': {
    dimension: 'evidence-density',
    label: 'Comparable rows',
    basis: 'measured',
  },
} as const satisfies Record<ArsCheckId, ArsCheckMeta>

/**
 * The six dimensions and their frozen weights (§3.4): 20 · 20 · 20 · 10 · 15 ·
 * 15 = 100, identical for every page kind. Each weight is the sum of its
 * checks' weights in `WEIGHTS`; both are written out because both are published,
 * and conformance fixture `052` asserts they agree and that the total is 100.
 */
export const DIMENSION_META = {
  retrievability: { label: 'Retrievability', weight: 28 },
  'machine-representation': { label: 'Machine representation', weight: 18 },
  'fact-coverage': { label: 'Fact coverage', weight: 20 },
  'fact-position': { label: 'Fact position', weight: 10 },
  'structured-data': { label: 'Structured data', weight: 6 },
  'contract-discovery': { label: 'Contract & discovery', weight: 10 },
  'evidence-density': { label: 'Evidence density', weight: 8 },
} as const satisfies Record<ArsDimensionId, { label: string; weight: number }>

/**
 * Published totals (§3.4). Heuristic weight has a spec ceiling of 40; fixture
 * `053` enforces it, and the ceiling is what shaped D7's basis split rather
 * than the other way round. Labelling `definitions` measured would have bought
 * three points of headroom and made "measured 63" a presentational number
 * instead of an honest one, which is the exact failure the ceiling exists to
 * prevent.
 */
export const ARS_MEASURED_WEIGHT = 63
export const ARS_HEURISTIC_WEIGHT = 37
export const ARS_HEURISTIC_WEIGHT_CEILING = 40

// ---------------------------------------------------------------------------
// Thresholds — the §3.6 scoring tables, as integer pairs
// ---------------------------------------------------------------------------

/**
 * All numeric bands from §3.6, encoded as flat `[threshold, value]` pairs so a
 * second implementation reads one shape rather than five. Integer arithmetic
 * only: no floating point anywhere in the scoring path, because cross-language
 * conformance is impossible with float rounding drift. All values are
 * non-negative, so rounding is unambiguous half-up via
 * `(numerator + denominator / 2) / denominator` in integer division.
 *
 * Two encodings, each stated per key:
 *   AT-LEAST — descending pairs; the first pair whose `threshold <= input` wins.
 *   AT-MOST  — ascending pairs; the first pair whose `input <= threshold` wins;
 *              no match scores 0.
 */
const THRESHOLDS = {
  /**
   * D3.1 fact weighting, in quarter-units (§3.6), as
   * `[corroboratedCore, uncorroboratedCore, corroboratedExtended, uncorroboratedExtended]`:
   *   coreUnits     = 4 × corroborated core + 2 × uncorroborated core
   *   extendedUnits = 1 × corroborated extended + 0 × uncorroborated extended
   * "Extended = ¼ credit" is the single definition of extended credit.
   */
  'fact-coverage.fact-units': [4, 2, 1, 0],
  /**
   * D3.1 denominator multiplier: `denominator = 4 × coreSize`, i.e. full credit
   * is every core fact corroborated. `coveragePct` is then
   * `min(100, (100 × (coreUnits + extendedUnits) + denominator / 2) / denominator)`.
   */
  'fact-coverage.core-denominator-multiplier': [4],
  /**
   * D3.1 density band. AT-LEAST over
   * `factsPerKiB100 = (coreFound × 100 + extendedFound × 25) × 1024 / max(1, bytes)`.
   * The `max(1, bytes)` clamp is normative and replaces `max(1, bytes / 1024)`,
   * which let a 200-byte stub top the band. Density saturates at ≥2 facts/KiB so
   * that keyword stuffing is pointless — fixtures `031` and `032` must score
   * identically.
   * Earned = `(14 × coveragePct × densityPct + 5000) / 10000`.
   */
  'fact-coverage.density': [200, 100, 100, 85, 50, 70, 20, 50, 5, 30, 0, 15],
  /**
   * D3.2 context cost, 6 pts. AT-MOST over
   * `ratio = 100 × bytes / byteReference[pageKind]`; above the last threshold, 0.
   */
  'fact-coverage.context-cost': [100, 6, 200, 5, 500, 3, 1500, 1],
  /**
   * D7.1 quantities, 4 pts. AT-LEAST over the count of DISTINCT quantity tokens
   * in the agent's counted text: a currency amount, a percentage, a number
   * carrying a unit, or an ISO date. Distinct, because a price repeated in a
   * header, a buy box and a footer is one fact stated three times, and counting
   * it three times would reward the repetition this score exists to discourage.
   * Saturates at 12 so a specification table cannot outscore a page that simply
   * states its facts.
   */
  'evidence-density.quantities': [12, 4, 6, 3, 3, 2, 1, 1],
  /**
   * D7.2 definitions, 2 pts. AT-LEAST over the count of `term: value` pairs the
   * agent can read as a labelled fact, counting markdown bold-label lines,
   * list items with a leading label, and HTML definition lists.
   */
  'evidence-density.definitions': [6, 2, 2, 1],
  /**
   * D7.3 comparisons, 2 pts. AT-LEAST over the number of comparable ROWS: a
   * table with at least two data columns contributes its data-row count, minus
   * the header. One row is not a comparison, so the band starts at two; three
   * options laid side by side is a full comparison and pays out. Calibrated
   * against fixture `060`, where a three-row size table is exactly the shape
   * this check exists to reward, and `063`, where one row is not.
   */
  'evidence-density.comparisons': [3, 2, 2, 1],
  /** D4.1 first-core-fact byte offset, 5 pts. AT-MOST over the offset in bytes; else 0. */
  'fact-position.first-core-fact-offset': [512, 5, 2048, 4, 8192, 2, 32768, 1],
  /**
   * D4.2 front window, 5 pts. AT-LEAST over the percentage of core facts whose
   * offset falls inside the window; below the last threshold, 0.
   */
  'fact-position.front-window': [90, 5, 70, 4, 50, 3, 25, 1],
  /**
   * D4.2 window size: `max(2048, bytes / 5)`, as `[floor, divisor]`. ONE
   * expression, integer division — the `0.2 × bytes` form is deleted, because
   * two implementations rounding a float disagree at the boundary.
   */
  'fact-position.front-window-size': [2048, 5],
  /**
   * Approximate token estimate, as `[bytesPerToken]`. HEURISTIC: decoded UTF-8
   * bytes are the normative measurement and approximate tokens are always
   * rendered with `≈` and an "est." chip. chars/4 is not a token count and the
   * spec says so.
   */
  'cost.approx-bytes-per-token': [4],
} as const satisfies Readonly<Record<string, readonly number[]>>

// ---------------------------------------------------------------------------
// Crawler audiences (§3.7)
// ---------------------------------------------------------------------------

/**
 * Robots `User-agent:` product tokens per audience, in their published casing.
 * Matching is case-insensitive (RFC 9309 §2.2.1) — the casing here is for the
 * rendered spec table.
 *
 * The `training` list exists so it can be treated NEUTRALLY. Blocking training
 * crawlers while allowing assistants scores identically to a fully open site,
 * and fixtures `021`/`022` exist solely to prove it, because it is the first
 * thing a hostile reviewer tests. `search` is reported only, and feeds the
 * `robots-contradiction` input; it never scores.
 *
 * This list is versioned data, not a heuristic: adding a token changes scores
 * for sites that named it, so additions land as a MINOR.
 */
const AUDIENCE_TOKENS = {
  /** User-triggered assistant fetches. THE audience ARS scores. */
  assistant: [
    'ChatGPT-User',
    'Claude-User',
    'Claude-SearchBot',
    'DuckAssistBot',
    'Meta-ExternalFetcher',
    'MistralAI-User',
    'OAI-SearchBot',
    'Perplexity-User',
  ],
  /** Corpus/model-training crawlers. STRICTLY NEUTRAL — never lowers the score. */
  training: [
    'AI2Bot',
    'Applebot-Extended',
    'Bytespider',
    'CCBot',
    'ClaudeBot',
    'Diffbot',
    'FacebookBot',
    'Google-Extended',
    'GPTBot',
    'Meta-ExternalAgent',
    'PanguBot',
    'Timpibot',
    'anthropic-ai',
    'cohere-ai',
    'omgili',
  ],
  /** Classic search indexers. Reported only. */
  search: ['Applebot', 'Baiduspider', 'Bingbot', 'DuckDuckBot', 'Googlebot', 'Slurp', 'YandexBot'],
} as const satisfies Record<'assistant' | 'training' | 'search', readonly string[]>

// ---------------------------------------------------------------------------
// D5.2 required properties (§3.6)
// ---------------------------------------------------------------------------

/**
 * The hand-curated required-property table, per page kind.
 *
 * PROVENANCE, stated because D5.2 is 7 points and merchants will ask where the
 * list came from: it is NOT "schema.org validity" — schema.org defines no
 * required properties at all — and it is NOT Google's rich-results guidelines by
 * reference, which change without a version and would make ARS scores move
 * without an ARS release. It is the CORE FACT SET of each page kind (see
 * `./profiles`) expressed in schema.org vocabulary, plus the properties without
 * which those facts are not actionable — a price with no `priceCurrency` cannot
 * be used by a buying agent, so `product` and `service` require both. The table
 * is bounded because it covers 8 kinds, not the full vocabulary, and it is
 * published in the spec next to this rationale.
 *
 * NOTATION: a dot is a property path from the top-level node; traversal enters
 * array members (`offers.price` matches `offers[0].price`). Alias handling
 * (`openingHours` vs `openingHoursSpecification`, `Article.headline` vs `name`)
 * belongs to the extractor, not to this table.
 *
 * `unknown` requires only `name`, deliberately: §3.5 scores `unknown` against
 * "any recognised schema.org type present", which requires having a type but
 * cannot require properties of a kind we did not identify.
 */
const REQUIRED_PROPERTIES = {
  product: ['name', 'offers.price', 'offers.priceCurrency', 'offers.availability'],
  collection: ['name', 'numberOfItems', 'itemListElement'],
  article: ['headline', 'author', 'datePublished'],
  place: ['name', 'address', 'openingHours', 'telephone'],
  service: ['name', 'offers.price', 'offers.priceCurrency', 'potentialAction.target'],
  faq: ['name', 'mainEntity', 'mainEntity.acceptedAnswer'],
  document: ['name', 'dateModified', 'publisher'],
  unknown: ['name'],
} as const satisfies Record<ArsPageKind, readonly string[]>

// ---------------------------------------------------------------------------
// Action lexicon (§3.5)
// ---------------------------------------------------------------------------

/**
 * Phrases that qualify a link, form or `potentialAction` as the page's
 * `primary-action-url`. Matched case-insensitively against normalised anchor
 * text / `name`, whitespace collapsed.
 *
 * ARS 0.3 ADDED THE COMMON ONES 0.2 MISSED. A shop whose button read "Shop
 * now", software whose button read "Install" or "Try it free", and a local
 * business whose button read "Get directions" were all told their main action
 * link was missing. The additions are the labels those pages actually use, each
 * still a whole phrase or a word-bounded prefix (`matchesLexicon`), so "shop"
 * matches "Shop now" and never "Workshop".
 *
 * PINNED, not inferred. §3.5 names ten stems — `book`, `apply`, `contact`,
 * `buy`, `subscribe`, `start`, `request`, `download`, `sign up`, `get a quote` —
 * "and their pinned synonyms"; this is that list. A lexicon that grew per page
 * (or per LLM call) would make `primary-action-url` non-deterministic, and
 * `primary-action-url` is a core fact for `service` and `unknown`, so it would
 * take the whole score with it. Sorted for readability; order is not
 * significant.
 */
const ACTION_LEXICON = [
  'add to bag',
  'add to basket',
  'add to cart',
  'apply',
  'apply now',
  'book',
  'book now',
  'buy',
  'buy now',
  'call',
  'call now',
  'check availability',
  'check out',
  'checkout',
  'contact',
  'contact us',
  'create account',
  'create an account',
  'donate',
  'download',
  'email us',
  'enquire',
  'enrol',
  'enroll',
  'free trial',
  'get a demo',
  'get a quote',
  'get directions',
  'get in touch',
  'get quote',
  'get started',
  'get the app',
  'get tickets',
  'hire',
  'inquire',
  'install',
  'join',
  'make an appointment',
  'message us',
  'order',
  'order now',
  'order online',
  'pre-order',
  'preorder',
  'purchase',
  'register',
  'rent',
  'request',
  'request a demo',
  'request a quote',
  'reserve',
  'schedule',
  'shop',
  'shop now',
  'sign up',
  'signup',
  'start',
  'start free trial',
  'subscribe',
  'talk to sales',
  'talk to us',
  'text us',
  'try',
  'upgrade',
] as const satisfies readonly string[]

// ---------------------------------------------------------------------------
// Bands (§3.6)
// ---------------------------------------------------------------------------

/**
 * ARS 0.3 integer grade bands (unchanged from 0.2). Meanings describe retrieved response structure;
 * they do not predict third-party output or certify business facts. Interfaces
 * can link the measurement methodology rather than repeat fixed boilerplate.
 */
const BANDS = [
  {
    grade: 'A',
    min: 90,
    max: 100,
    label: 'Agent-native',
    meaning:
      'Facts are in a machine representation, complete for this page kind, front-loaded, and cheap to fetch.',
  },
  {
    grade: 'B',
    min: 75,
    max: 89,
    label: 'Agent-friendly',
    meaning:
      'All core facts are present and findable; the agent pays more bytes than it needs, or one signal is missing.',
  },
  {
    grade: 'C',
    min: 60,
    max: 74,
    label: 'Readable with effort',
    meaning: 'Core facts are extractable from HTML, at high cost.',
  },
  {
    grade: 'D',
    min: 40,
    max: 59,
    label: 'Partial',
    meaning: 'Some core facts for this page kind were not found in the fetched response.',
  },
  {
    grade: 'F',
    min: 0,
    max: 39,
    label: 'Not extractable',
    meaning: 'Few or no core facts for this page kind were found in the fetched response.',
  },
] as const satisfies readonly ArsBand[]

// ---------------------------------------------------------------------------
// The ruleset
// ---------------------------------------------------------------------------

/**
 * ARS 0.3's frozen ruleset. Weights and bands are 0.2's; the action lexicon grew.
 *
 * DESIGNED CEILINGS, printed in the spec (§8) as intentional rather than
 * discovered, and stated here in 0.2's numbers: no content negotiation loses
 * D2.1 (9) + D2.3 (3, gated on D2.1) + D2.4 (3, nothing comparable) → max 85,
 * capped at B. No valid structured data loses all of D5 (6) → max 94, so an A is
 * still reachable. Reaching an A therefore requires a machine representation and
 * NO LONGER requires structured data — 0.1 required both, and 0.2 does not.
 * Provable from these numbers alone, which is why the whole ruleset is published
 * rather than described.
 */
export const DEFAULT_RULESET = deepFreeze({
  version: '0.3.0',
  weights: WEIGHTS,
  thresholds: THRESHOLDS,
  audienceTokens: AUDIENCE_TOKENS,
  requiredProperties: REQUIRED_PROPERTIES,
  actionLexicon: ACTION_LEXICON,
  /** 2 MiB decoded. Streamed and aborted at the cap; `await response.text()` is forbidden. */
  maxBodyBytes: 2 * 1024 * 1024,
  /** 3 hops. Every hop re-resolves DNS and re-validates (§5.2). */
  maxRedirects: 3,
  /** 5s per request. See the ADDED note on `ArsRuleset` in ./types. */
  timeoutMs: 5_000,
  profiles: PROFILES,
  bands: BANDS,
} as const satisfies ArsRuleset)
