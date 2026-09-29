/**
 * types.ts — the public contract of the Agent Readability Score, ARS 0.2.
 *
 * Transcribed from the ARS design document's §3.9, which is the decided
 * contract. Where §3.9 abbreviates (it writes `id: string`
 * for a check id whose format it then demonstrates), this file fills the gap
 * consistently with the §3.4 dimension table and the §3.6 scoring tables. Two
 * deliberate narrowings and one addition are marked NARROWED / ADDED below;
 * nothing else departs from the design.
 *
 * WHY THE TYPES MATTER MORE THAN USUAL HERE. ARS is published as a standard
 * (https://rebilder.com/spec/ars), and its determinism
 * guarantee is stated as: *for a given `evidenceHash`, `rulesetHash` and
 * `corpusHash`, `score()` returns a byte-identical `ArsResult` in any conformant
 * implementation, in any language.* A second implementation in Go or Python
 * reproduces `expected.json` from the conformance corpus, and these types are
 * the schema of that file. A field added casually here is a field an outside
 * team has to reverse-engineer.
 *
 * SHAPE OF THE SYSTEM. The impure half (`./probe`) produces exactly one thing:
 * an `ArsEvidence` bundle. The pure half (`.`) consumes exactly that, plus an
 * `ArsRuleset`, and produces an `ArsResult`. There is no third input — no
 * clock, no network, no randomness, no LLM. The ESLint rule in
 * `eslint.config.mjs` enforces that at build time.
 */

/**
 * The spec version this package implements. See §3.1 for the versioning rules.
 *
 * THIS IS THE SECOND PLACE THE VERSION IS WRITTEN — `DEFAULT_RULESET.version` is
 * the first — and the two are asserted equal in `tests/score.test.ts` for the
 * same reason `SUBPOINTS` is asserted against `WEIGHTS`: they disagreed once,
 * during the 0.2 rebalance, and the visible symptom was every result printing
 * `specVersion: '0.1.0'` next to a 0.2 `rulesetHash`. A score whose two identity
 * fields name different versions is worse than one that names neither.
 *
 * It cannot simply be re-exported from the ruleset: `types.ts` is the bottom of
 * the import graph and `ruleset.ts` imports from it.
 */
export const ARS_SPEC_VERSION = '0.2.0' as const

/**
 * Where the scan was taken from.
 * - `public` — an anonymous third-party scan. The only vantage that is robots-gated.
 * - `authenticated` — a signed-in Rebilder user scanning a domain they have verified.
 * - `self` — the site's own operator (Console, or the CLI run against their own
 *   origin). Bypasses the `rebilder-ars` token check, because the owner can
 *   consent for their own origin (§3.7).
 */
export type ArsVantage = 'public' | 'authenticated' | 'self'

/**
 * Whether a check's earned points come from an observation or from an inference.
 * Published per check, and the total heuristic weight is capped at 40 of 100
 * (37 in 0.2) and printed. See §5.1.
 */
export type ArsBasis = 'measured' | 'heuristic'

export type ArsGrade = 'A' | 'B' | 'C' | 'D' | 'F'

/**
 * The three crawler audiences (§3.7). `training` is strictly neutral: blocking
 * training crawlers while allowing assistants scores identically to a fully open
 * site (conformance fixtures 021 and 022 exist to prove exactly that).
 */
export type ArsAudience = 'assistant' | 'training' | 'search'

export type ArsUnscoredReason =
  | 'blocked-at-edge'
  | 'unreachable'
  | 'non-2xx'
  | 'too-many-redirects'
  | 'robots-disallow-scanner'
  | 'robots-unavailable'
  | 'truncated-evidence'
  | 'evidence-incomplete'

/**
 * The three outcomes. Two of them carry no letter grade at all: a deliberate
 * opt-out is a choice, not a failure, and an unscored target is a missing
 * observation, not a bad one. Neither is ever ranked or listed (§3.6).
 */
export type ArsOutcome =
  | { kind: 'scored'; grade: ArsGrade; score: number }
  | { kind: 'opt-out'; audience: ArsAudience; wellFormed: true }
  | { kind: 'unscored'; reason: ArsUnscoredReason; detail?: string }

/* ── evidence: the impure half's output, the pure half's only input ───────── */

export interface ArsHttpCapture {
  requestedUrl: string
  finalUrl: string
  redirects: { status: number; location: string }[]
  status: number
  /**
   * Lowercased header names → all values. An array, not a string, because
   * `Link` is routinely sent multiple times and is scored (D2.2, D6.5).
   * Volatile headers (`date`, `age`, `set-cookie`, `x-request-id`, `cf-ray`,
   * `report-to`) are excluded before hashing — without that exclusion the
   * evidence hash changes on every scan of every real site and replay dies.
   */
  headers: Record<string, string[]>
  /**
   * Decoded byte length. NORMATIVE MEASUREMENT — bodies are decoded per the
   * `Content-Type` charset (default UTF-8) and this is the UTF-8 byte length of
   * the result, so a Go implementation reproduces D3.2 and D4 offsets exactly.
   */
  bytes: number
  /** SHA-256 of the raw decoded body, hex. Published; the body is not. */
  bodySha256: string
  /** Present in-process and for a verified owner. NEVER in a published bundle. */
  body?: string
  /**
   * True when the 2 MiB body cap was hit. Surfaced in the UI and the byte figure
   * rendered as "≥ N bytes": silently scoring a truncated body makes the worst
   * sites score best on the one number the product is built on (§3.3).
   */
  truncated: boolean
}

export type ArsProbeError =
  | 'timeout'
  | 'unreachable'
  | 'non-2xx'
  | 'blocked-redirect'
  | 'too-many-redirects'
  | 'challenge'
  | 'policy-rejected'

export interface ArsProbeRecord {
  requestHeaders: Record<string, string>
  result:
    | { ok: true; capture: ArsHttpCapture }
    | { ok: false; error: ArsProbeError; detail?: string }
}

export interface ArsEvidence {
  evidenceVersion: '0.1.0'
  target: { url: string; origin: string }
  /**
   * `agent` and `browser` differ ONLY in the `Accept` header — same User-Agent,
   * same everything else. That is what makes the D2.4 parity check meaningful
   * and what stops a correctly installed gateway (which negotiates on `Accept`,
   * not on UA) from being scored as a cloaker (§3.3).
   */
  probes: {
    agent: ArsProbeRecord
    browser: ArsProbeRecord
    /** Third probe, ≥30s later, taken only when divergence was detected (§3.8). */
    parityConfirm: ArsProbeRecord | null
    robotsTxt: ArsProbeRecord | null
    llmsTxt: ArsProbeRecord | null
    wellKnownUcp: ArsProbeRecord | null
  }
  vantage: ArsVantage
  /** Wall clock. EXCLUDED from evidenceHash — never an input to scoring. */
  capturedAt: string
}

/* ── facts ───────────────────────────────────────────────────────────────── */

/**
 * A closed set of 8. Every kind has exactly one complete profile (see
 * `./profiles`); a property test asserts the mapping is total. `unknown` is not
 * an easy exit — it still scores D5.2 against "any recognised schema.org type
 * present", so hiding your page kind costs points and gains nothing (§3.5).
 */
export type ArsPageKind =
  | 'product'
  | 'collection'
  | 'article'
  | 'place'
  | 'service'
  | 'faq'
  | 'document'
  | 'unknown'

/**
 * Every fact name any profile may reference. Conformance fixture `058` asserts
 * that every name in every profile is a member of this union — the union is the
 * vocabulary, and a profile naming a fact outside it is a spec bug.
 */
export type ArsFactKind =
  | 'title'
  | 'description'
  | 'updated'
  | 'published'
  | 'price'
  | 'currency'
  | 'availability'
  | 'brand'
  | 'sku'
  | 'shipping'
  | 'returns'
  | 'org-name'
  | 'address'
  | 'hours'
  | 'phone'
  | 'email'
  | 'service-area'
  | 'author'
  | 'section'
  | 'authority'
  | 'primary-action-url'
  | 'eligibility'
  | 'duration'
  | 'question-answer'
  | 'item-count'
  | 'item-link'

export interface ArsFactProfile {
  pageKind: ArsPageKind
  core: readonly ArsFactKind[]
  extended: readonly ArsFactKind[]
  /**
   * Byte reference for D3.2, in bytes. Varies by kind; weights never do. This
   * is the mechanism that stops long-form content (articles, docs) being
   * structurally capped around C — the defect in every design that used
   * absolute byte bands (§3.5).
   */
  byteReference: number
}

export interface ArsFactObservation {
  kind: ArsFactKind
  /** Normalised (money → minor units + ISO currency; dates → ISO 8601). */
  normalized: string
  source: 'json-ld' | 'microdata' | 'meta' | 'html-text' | 'negotiated'
  /**
   * UTF-8 byte offset of the first occurrence in the decoded body. A measured
   * offset of a heuristic fact — the offset itself is not a guess, which is why
   * D4 reports it as evidence even though D4's checks are heuristic.
   */
  offset: number
  /** Observed in ≥2 sources (e.g. JSON-LD and visible text). §3.6. */
  corroborated: boolean
}

/* ── scoring ─────────────────────────────────────────────────────────────── */

export type ArsDimensionId =
  | 'retrievability'
  | 'machine-representation'
  | 'fact-coverage'
  | 'fact-position'
  | 'structured-data'
  | 'contract-discovery'
  | 'evidence-density'

/**
 * Every check id in ARS 0.2, in dimension order, matching the §5.1 table row for
 * row. The `<dimension>.<check>` shape is normative: the prefix IS the
 * `ArsDimensionId`, so a check's dimension is derivable from its id and the two
 * can never disagree. §3.9 demonstrates the format with
 * `'retrievability.render-independence'` and leaves the rest implied; this is
 * that list, written out.
 *
 * NARROWED vs §3.9: `ArsCheck['id']` is this union rather than `string`. These
 * ids are published in the spec and appear in every `expected.json`; an
 * unconstrained string in a frozen contract is a typo waiting to ship.
 */
export type ArsCheckId =
  // D1 Retrievability — 20
  | 'retrievability.reachable' // D1.1, 8, measured
  | 'retrievability.robots-policy' // D1.2, 6, measured
  | 'retrievability.render-independence' // D1.3, 6, heuristic
  // D2 Machine representation — 20
  | 'machine-representation.negotiated-response' // D2.1, 10, measured
  | 'machine-representation.declared-alternates' // D2.2, 4, measured
  | 'machine-representation.vary-accept' // D2.3, 3, measured
  | 'machine-representation.substance-parity' // D2.4, 3, heuristic
  // D3 Fact coverage — 20
  | 'fact-coverage.core-facts' // D3.1, 14, heuristic
  | 'fact-coverage.context-cost' // D3.2, 6, measured
  // D4 Fact position — 10
  | 'fact-position.first-core-fact-offset' // D4.1, 5, heuristic
  | 'fact-position.front-window' // D4.2, 5, heuristic
  // D5 Structured data — 15
  | 'structured-data.present' // D5.1, 5, measured
  | 'structured-data.required-properties' // D5.2, 7, measured
  | 'structured-data.text-agreement' // D5.3, 3, heuristic
  // D6 Contract & discovery — 15
  | 'contract-discovery.canonical' // D6.1, 4, measured
  | 'contract-discovery.cache-validators' // D6.2, 3, measured
  | 'contract-discovery.llms-txt' // D6.3, 2, measured
  | 'contract-discovery.sitemap' // D6.4, 2, measured
  | 'contract-discovery.machine-endpoint' // D6.5, 2, measured
  // D7 Evidence density — 8
  | 'evidence-density.quantities' // D7.1, 4, measured
  | 'evidence-density.definitions' // D7.2, 2, heuristic
  | 'evidence-density.comparisons' // D7.3, 2, measured

export interface ArsCheckEvidence {
  label: string
  value: string
  basis: ArsBasis
}

export interface ArsCheck {
  /** e.g. 'retrievability.render-independence'. */
  id: ArsCheckId
  label: string
  basis: ArsBasis
  weight: number
  /** Integer, 0..weight. No floating point anywhere in the scoring path (§3.6). */
  earned: number
  evidence: ArsCheckEvidence[]
  remedy?: string
}

export interface ArsDimension {
  id: ArsDimensionId
  label: string
  weight: number
  earned: number
  /** 'heuristic' if ANY constituent check is heuristic. */
  basis: ArsBasis
  checks: ArsCheck[]
}

export type ArsFlagId =
  | 'substance-divergence'
  | 'structured-data-divergence'
  | 'robots-contradiction'
  | 'paywalled'
  | 'render-dependent'
  | 'scanner-blocked'
  | 'training-opt-out'
  | 'assistant-opt-out'
  | 'vary-missing'
  | 'canonical-mismatch'
  | 'body-truncated'
  | 'vantage-variance'

export interface ArsFlag {
  id: ArsFlagId
  /**
   * No 'critical'. No check publicly accuses anyone: a divergence flag reports
   * *"the agent representation reported price X; the HTML representation
   * reported price Y at capture time"*, which is an observation, not a charge of
   * cloaking (§3.8).
   */
  severity: 'info' | 'warn'
  basis: ArsBasis
  message: string
  evidence: ArsCheckEvidence[]
}

export interface ArsAudienceDecision {
  decision: 'allow' | 'disallow' | 'unspecified'
  matchedGroup: string | null
  matchedRule: string | null
}

export interface ArsPolicyReport {
  robotsTxtStatus: 'ok' | 'missing' | 'error' | 'unparseable'
  audiences: Record<ArsAudience, ArsAudienceDecision>
  deliberateOptOut: boolean
  /** NEUTRAL. Never lowers the score. */
  trainingOptOut: boolean
  sitemapDeclared: boolean
}

export interface ArsCostReport {
  htmlBytes: number
  negotiatedBytes: number | null
  /** HEURISTIC (chars/4). Always rendered with ≈ and an "est." chip. */
  approxHtmlTokens: number
  approxNegotiatedTokens: number | null
  reductionRatio: number | null
  firstCoreFactOffset: number | null
  truncated: boolean
}

export interface ArsRecommendation {
  id: string
  title: string
  /**
   * Points recoverable, after dependency dedup: a recommendation counts only
   * checks not claimed by a higher-ranked recommendation, plus the checks it
   * uniquely unlocks. Sums per dimension are capped at the dimension weight, and
   * a property test asserts `Σ pointsAvailable ≤ 100 − score` (§3.9). Merchants
   * act on this surface, so the arithmetic is specified rather than implied.
   */
  pointsAvailable: number
  effort: 'config' | 'template' | 'engineering'
  detail: string
  /** Check ids this closes. */
  checks: ArsCheckId[]
  /** Check ids it unlocks (e.g. D2.1 unlocks D2.3, which is gated on it). */
  unlocks: ArsCheckId[]
}

export interface ArsResult {
  spec: 'ars'
  specVersion: string
  /** SHA-256 of RFC 8785 canonical JSON of the frozen ruleset. */
  rulesetHash: string
  /** SHA-256 over the conformance corpus; pins observable behaviour. */
  corpusHash: string
  evidenceHash: string
  vantage: ArsVantage
  target: { url: string; finalUrl: string; origin: string }

  outcome: ArsOutcome
  score: number | null
  grade: ArsGrade | null
  bandLabel: string | null

  pageKind: ArsPageKind
  pageKindBasis: ArsBasis // always 'heuristic' in 0.1
  pageKindConfidence: 'high' | 'medium' | 'low'
  factProfile: ArsFactProfile
  facts: ArsFactObservation[]

  /** Always 6 entries, weights always summing to 100. */
  dimensions: ArsDimension[]
  flags: ArsFlag[]
  policy: ArsPolicyReport
  cost: ArsCostReport
  recommendations: ArsRecommendation[]

  measuredWeight: number // 64 in 0.1
  heuristicWeight: number // 36 in 0.1; ceiling 40, enforced by fixture 053
}

export interface ArsBand {
  grade: ArsGrade
  min: number
  max: number
  label: string
  /** Descriptive only. Never predictive of third-party AI behaviour (§3.6). */
  meaning: string
}

/**
 * The frozen, hashed ruleset. Everything a second implementation needs to
 * reproduce a score, and nothing that varies between runs.
 *
 * ADDED vs §3.9: `timeoutMs`. §3.9's listing stops at `maxRedirects`, but §5.2
 * pins the probe timeout at 5 000ms in the same breath as the body cap and the
 * redirect limit, and the same argument applies to all three — two
 * implementations with different timeouts disagree about which pages are
 * scoreable at all, which is a score difference wearing a disguise.
 */
export interface ArsRuleset {
  version: string
  /** Check id → points. Must sum to exactly 100. Frozen per version. */
  weights: Readonly<Record<string, number>>
  /**
   * The §3.6 numeric bands, as flat integer arrays. Each key documents its own
   * encoding in `./ruleset`; all of them are `[threshold, value]` pairs so that a
   * second implementation reads one shape, not five.
   */
  thresholds: Readonly<Record<string, readonly number[]>>
  /** Robots `User-agent:` tokens per audience. Matched case-insensitively. */
  audienceTokens: Readonly<Record<ArsAudience, readonly string[]>>
  /** Hand-curated required properties per page kind. Provenance in the spec. */
  requiredProperties: Readonly<Record<ArsPageKind, readonly string[]>>
  /** Anchor/action phrases that qualify a link as `primary-action-url` (§3.5). */
  actionLexicon: readonly string[]
  maxBodyBytes: number // 2 MiB, normative
  maxRedirects: number // 3, normative
  timeoutMs: number // 5_000, normative (see the ADDED note above)
  profiles: readonly ArsFactProfile[] // total over ArsPageKind
  bands: readonly ArsBand[]
}
