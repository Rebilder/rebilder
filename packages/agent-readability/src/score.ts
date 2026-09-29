/**
 * score.ts — the ARS 0.2 scoring engine. The whole pure half comes together here.
 *
 * THE CONTRACT. `score(evidence, ruleset)` is a pure function: same evidence,
 * same ruleset, same `ArsResult`, byte for byte, in any conformant
 * implementation in any language. No network, no clock, no randomness, no LLM.
 * The ESLint rule in `eslint.config.mjs` enforces the first three at build time;
 * the fourth has nowhere to hide, because there is no model call anywhere in this
 * package.
 *
 * INTEGER ARITHMETIC ONLY (§3.6). Every number below is produced by `idiv` /
 * `divRoundHalfUp`, never by `/` on values that do not divide, and never by
 * `Math.round`. Cross-language conformance is impossible with float rounding
 * drift, and publishing a standard whose scores differ in the third
 * implementation would be worse than publishing nothing. All inputs are
 * non-negative, so rounding is unambiguous half-up via
 * `(numerator + denominator / 2) / denominator`.
 *
 * FIXED WEIGHTS. 100 points for every page, whatever its kind. What varies by
 * page kind is the fact set and the byte reference (`./profiles`) — never a
 * weight. Redistribution would be a gaming vector: make the dimension you are bad
 * at inapplicable and everything else inflates.
 *
 * TWO GATES EXIST, AND THEY POINT THE SAFE WAY. D2.3 (`Vary: Accept`) and D2.4
 * (substance parity) are gated on D2.1 (a machine representation was served),
 * which is a MEASURED check gating others. That direction is fine and is what
 * makes the published ceiling provable: no content negotiation loses D2.1 (10) +
 * D2.3 (3) + D2.4 (3) → max 84 → capped at B. The forbidden direction — a
 * heuristic that can zero measured points — appears nowhere. In particular D2.4
 * and D5.3 are SCORED CHECKS, NOT GATES: a parity failure loses its own 3 points
 * and raises a `warn`, and leaves D2's other 17 measured points alone. That is
 * the whole reason "measured 64 / heuristic 36" is an honest split rather than a
 * presentational one.
 *
 * WHICH REPRESENTATION SCORES WHAT (the decision `./extract` states in its own
 * header, repeated here because it is the reason the golden pair means anything):
 * D3 (coverage) and D4 (position) score the AGENT representation, because ARS
 * measures what a caller actually receives. D1.3 (render independence) and D5
 * (structured data) score the representation that carries a document, because
 * those checks are about the HTML a caller that only reads HTML gets.
 *
 * MEASURED CHECKS NEVER AWARD POINTS FOR AN OBSERVATION WE DID NOT MAKE. When
 * the browser probe is missing, the sub-conditions that compare the two probes
 * (D1.1's "no Accept-conditional redirect", D6.1's "self-consistent") score 0 and
 * say so in their evidence. Awarding them by default would make a measured check
 * heuristic; deducting them silently would be unexplained. The evidence line is
 * the difference.
 *
 * WHAT LIVES IN THE RULESET AND WHAT LIVES HERE. `DEFAULT_RULESET.thresholds`
 * holds exactly the §3.6 numeric tables (density, context cost, offsets, front
 * window). The remaining checks are conjunctions of named conditions rather than
 * bands, and their point splits are `SUBPOINTS` below: published, frozen, and —
 * like the classification tables in `./classify` — NOT covered by `rulesetHash`,
 * because §3.9's `ArsRuleset` has no field for them. That gap is recorded in the
 * package README as a known limitation of 0.1 rather than papered over.
 */

import { classify, isRecognisedType, nodeForKind, pass1Signals } from './classify'
import type { ArsClassification } from './classify'
import {
  buildPolicyReport,
  buildRepresentation,
  extractFacts,
  hasPath,
  header,
  headerAll,
  mergeFacts,
  parseRobots,
  pathMatches,
  readPath,
} from './extract'
import type {
  ArsRepresentation,
  ExtractedFact,
  JsonLdNode,
  MergedFact,
  RobotsFile,
} from './extract'
import { attr, elementText } from './html'
import { profileFor } from './profiles'
import { recommend } from './recommend'
import { CHECK_META, DEFAULT_RULESET, DIMENSION_META } from './ruleset'
import type {
  ArsAudience,
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
  ArsPolicyReport,
  ArsProbeRecord,
  ArsResult,
  ArsRuleset,
  ArsUnscoredReason,
} from './types'
import { ARS_SPEC_VERSION } from './types'

// ---------------------------------------------------------------------------
// Integer arithmetic (§3.6)
// ---------------------------------------------------------------------------

/**
 * Exact integer division for non-negative safe integers. `%` is exact, the
 * subtraction is exact, and dividing by an exact multiple is exact, so this
 * never rounds — unlike `Math.floor(a / b)`, whose intermediate quotient is an
 * IEEE-754 double that can land on the wrong side of an integer boundary. A
 * scoring path that is "almost always" the same in two languages is not a
 * standard.
 */
function idiv(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return (numerator - (numerator % denominator)) / denominator
}

/** §3.6's half-up rounding, `(numerator + denominator / 2) / denominator`, in integers. */
function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return idiv(numerator + idiv(denominator, 2), denominator)
}

/**
 * AT-LEAST table lookup: flat `[threshold, value]` pairs in DESCENDING threshold
 * order; the first pair whose `threshold <= input` wins. No match scores 0, which
 * can only happen if a ruleset omits the table — a malformed ruleset must not
 * silently invent points.
 */
function atLeast(pairs: readonly number[] | undefined, input: number): number {
  if (pairs === undefined) return 0
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const threshold = pairs[i]
    const value = pairs[i + 1]
    if (threshold === undefined || value === undefined) return 0
    if (input >= threshold) return value
  }
  return 0
}

/**
 * AT-MOST table lookup: flat `[threshold, value]` pairs in ASCENDING threshold
 * order; the first pair whose `input <= threshold` wins; no match scores 0.
 */
function atMost(pairs: readonly number[] | undefined, input: number): number {
  if (pairs === undefined) return 0
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const threshold = pairs[i]
    const value = pairs[i + 1]
    if (threshold === undefined || value === undefined) return 0
    if (input <= threshold) return value
  }
  return 0
}

/** Recursively freezes a plain data structure. Used on `SUBPOINTS`. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

// ---------------------------------------------------------------------------
// Sub-point splits
// ---------------------------------------------------------------------------

/**
 * The point split inside each check that scores a CONJUNCTION of named
 * conditions rather than a numeric band. §3.4 states the conditions ("D1.1 2xx on
 * the agent path, ≤3 hops, no Accept-conditional redirect"); this is how the
 * check's points are divided between them, and every split sums to the check's
 * weight in `DEFAULT_RULESET.weights`.
 *
 * Published here rather than in `DEFAULT_RULESET` because §3.9's `ArsRuleset` has
 * no field for them. The consequence is stated rather than hidden: these numbers
 * are NOT covered by `rulesetHash`, exactly like the classification tables in
 * `./classify`. Editing one moves conformance `expected.json` files and is
 * therefore a MINOR, and the corpus is what actually pins them.
 */
/**
 * The per-check point splits.
 *
 * THESE MUST SUM TO `WEIGHTS`, and until ARS 0.2 nothing said so. The ruleset
 * carried the same numbers twice, here and in `WEIGHTS`, with fixture `052`
 * checking only that `DIMENSION_META` agreed with `WEIGHTS`. Rebalancing for
 * 0.2 changed `WEIGHTS` alone and every check kept emitting 0.1's points, so
 * the corpus re-scored with dimensions claiming 28 while their checks could
 * only pay 20. `subpointTotals()` below closes that, and `score.test.ts`
 * asserts the two tables agree check by check.
 */
export const SUBPOINTS = deepFreeze({
  /** D1.1, 11 = 5 + 3 + 3. */
  reachable: { status2xx: 5, withinRedirectLimit: 3, noAcceptConditionalRedirect: 3 },
  /** D1.2, 10 = 6 + 2 + 1 + 1. A disallowed assistant audience scores 0 for all four (§3.7). */
  robotsPolicy: { assistantAllowed: 6, parsesClean: 2, noOrphanRules: 1, sitemapDeclared: 1 },
  /**
   * D1.3, 7. AT-LEAST band over `100 × coreFactsInHtml / coreProfileSize`, plus
   * the `<noscript>` floor: a page whose facts are all client-rendered but which
   * ships a non-empty `<noscript>` has told a JS-less caller something, and §3.8
   * says that earns partial credit.
   */
  renderIndependence: {
    band: [100, 7, 75, 5, 50, 3, 25, 1] as readonly number[],
    noscriptFloor: 1,
  },
  /** D2.1, 9. All-or-nothing: a machine media type AND a body that is not HTML. */
  negotiatedResponse: { full: 9 },
  /** D2.2, 3. All-or-nothing. */
  declaredAlternates: { full: 3 },
  /** D2.3, 3. All-or-nothing, and 0 unless D2.1 > 0. */
  varyAccept: { full: 3 },
  /** D2.4, 3. All-or-nothing, and 0 unless D2.1 > 0 and a browser capture exists. */
  substanceParity: { full: 3 },
  /** D5.1, 2. Structured data present AND parsing; a partly-broken graph scores 1. */
  structuredDataPresent: { clean: 2, partial: 1 },
  /** D5.2, 3 = 1 (a recognised type) + 2 (required-property completeness, scaled). */
  requiredProperties: { recognisedType: 1, completeness: 2 },
  /** D5.3, 1. All-or-nothing. */
  textAgreement: { full: 1 },
  /** D6.1, 4 = 2 + 1 + 1. */
  canonical: { present: 2, absolute: 1, consistentAcrossProbes: 1 },
  /** D6.2, 2 = 1 + 1. */
  cacheValidators: { saneCacheControl: 1, validator: 1 },
  /**
   * D6.3, 1. `specShaped` — an H1 and at least one Markdown link — is the whole
   * point. `present` is 0 in 0.2: at two points 0.1 could pay one for the file
   * existing and one for it being usable, but at one point that split would make
   * "exists" and "usable" score identically, which is a distinction the standard
   * would then be printing a remedy for and paying nothing to fix.
   */
  llmsTxt: { present: 0, specShaped: 1 },
  /** D6.4, 1. All-or-nothing. */
  sitemap: { full: 1 },
  /** D6.5, 2. All-or-nothing over any ONE declared machine endpoint. */
  machineEndpoint: { full: 2 },
})

/**
 * The maximum each SUBPOINTS entry can pay, for the agreement assertion. A band
 * pays its highest value; `structuredDataPresent` and `llmsTxt` are graded, so
 * the best branch is the max, not the sum.
 */
export function subpointTotals(): Record<string, number> {
  const s = SUBPOINTS
  return {
    'retrievability.reachable':
      s.reachable.status2xx + s.reachable.withinRedirectLimit + s.reachable.noAcceptConditionalRedirect,
    'retrievability.robots-policy':
      s.robotsPolicy.assistantAllowed +
      s.robotsPolicy.parsesClean +
      s.robotsPolicy.noOrphanRules +
      s.robotsPolicy.sitemapDeclared,
    'retrievability.render-independence': s.renderIndependence.band[1] ?? 0,
    'machine-representation.negotiated-response': s.negotiatedResponse.full,
    'machine-representation.declared-alternates': s.declaredAlternates.full,
    'machine-representation.vary-accept': s.varyAccept.full,
    'machine-representation.substance-parity': s.substanceParity.full,
    'structured-data.present': s.structuredDataPresent.clean,
    'structured-data.required-properties':
      s.requiredProperties.recognisedType + s.requiredProperties.completeness,
    'structured-data.text-agreement': s.textAgreement.full,
    'contract-discovery.canonical':
      s.canonical.present + s.canonical.absolute + s.canonical.consistentAcrossProbes,
    'contract-discovery.cache-validators': s.cacheValidators.saneCacheControl + s.cacheValidators.validator,
    'contract-discovery.llms-txt': s.llmsTxt.specShaped,
    'contract-discovery.sitemap': s.sitemap.full,
    'contract-discovery.machine-endpoint': s.machineEndpoint.full,
  }
}

// ---------------------------------------------------------------------------
// SHA-256 and RFC 8785 canonical JSON
// ---------------------------------------------------------------------------

/**
 * WHY A HAND-ROLLED SHA-256 LIVES IN THE PURE HALF. `ArsResult` carries three
 * hashes and the determinism guarantee is stated in terms of them, so `score()`
 * has to compute two of them. `node:crypto` would make this package Node-only,
 * and browser and edge callers import the root entry point; `crypto.subtle` is async
 * and `score()` is not. A dependency is out — the package's contract is zero
 * runtime dependencies, and a third-party hash version would be an unversioned
 * input to a hashed artifact, which is the same argument that made the tokenizer
 * hand-rolled. So: ~80 lines of FIPS 180-4, checked against the published test
 * vectors in `tests/score.test.ts`.
 */
const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

/** SHA-256 of a UTF-8 string, lowercase hex. FIPS 180-4. */
export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message)
  const bitLength = bytes.length * 8
  // Padded length: message + 0x80 + zeros + 8 length bytes, to a 64-byte multiple.
  const padded = new Uint8Array((idiv(bytes.length + 9 + 63, 64) || 1) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  // Length as a 64-bit big-endian bit count. Bodies are capped at 2 MiB, so the
  // high word is always zero; it is written anyway so the routine is correct for
  // any input a caller hands it.
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, idiv(bitLength, 0x100000000), false)
  view.setUint32(padded.length - 4, bitLength >>> 0, false)

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const w = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0
      const b = w[i - 2] ?? 0
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0
  }

  let hex = ''
  for (const word of h) hex += word.toString(16).padStart(8, '0')
  return hex
}

/**
 * RFC 8785 (JCS) canonical JSON, over the value shapes ARS actually hashes:
 * objects, arrays, strings, booleans, null and JSON numbers.
 *
 * Two details make this RFC-conformant rather than merely deterministic:
 * object keys are sorted by UTF-16 code unit (JCS §3.2.3, which is what
 * JavaScript's default string comparison already does), and numbers are
 * serialised with `JSON.stringify`, whose output is the ECMAScript
 * `Number::toString` shortest round-trip form that JCS §3.2.2.3 mandates.
 * `undefined` and functions cannot appear in the data we hash and are dropped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => record[key] !== undefined)
    keys.sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return 'null'
}

/** SHA-256 of the RFC 8785 canonical JSON of the frozen ruleset (§3.1). */
export function rulesetHash(ruleset: ArsRuleset): string {
  return sha256Hex(canonicalJson(ruleset))
}

/**
 * Headers excluded from `evidenceHash` (§3.3). Without this exclusion the hash
 * changes on every scan of every real site — `date` alone guarantees it — and the
 * replay story, which is the only reason the hash is published, dies.
 */
const VOLATILE_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'age',
  'set-cookie',
  'x-request-id',
  'cf-ray',
  'report-to',
])

function stableHeaders(
  headers: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const [name, values] of Object.entries(headers)) {
    if (VOLATILE_HEADERS.has(name.toLowerCase())) continue
    out[name.toLowerCase()] = values
  }
  return out
}

/**
 * SHA-256 over the evidence bundle with the volatile fields removed: the header
 * denylist above, and `capturedAt`, which is wall-clock time and is never an
 * input to scoring. Bodies ARE hashed — `bodySha256` is already in the capture,
 * but hashing the body itself means a bundle whose body was edited without
 * updating its digest does not silently keep its identity.
 */
export function evidenceHash(evidence: ArsEvidence): string {
  const redactProbe = (probe: ArsProbeRecord | null): unknown => {
    if (probe === null) return null
    if (!probe.result.ok) return { requestHeaders: probe.requestHeaders, result: probe.result }
    const capture = probe.result.capture
    return {
      requestHeaders: probe.requestHeaders,
      result: {
        ok: true,
        capture: { ...capture, headers: stableHeaders(capture.headers) },
      },
    }
  }
  return sha256Hex(
    canonicalJson({
      evidenceVersion: evidence.evidenceVersion,
      target: evidence.target,
      vantage: evidence.vantage,
      probes: {
        agent: redactProbe(evidence.probes.agent),
        browser: redactProbe(evidence.probes.browser),
        parityConfirm: redactProbe(evidence.probes.parityConfirm),
        robotsTxt: redactProbe(evidence.probes.robotsTxt),
        llmsTxt: redactProbe(evidence.probes.llmsTxt),
        wellKnownUcp: redactProbe(evidence.probes.wellKnownUcp),
      },
    }),
  )
}

/**
 * Version marker for the ARS 0.2 corpus (spec §2.4.3).
 * This is the hash of the versioned marker string, not of fixture contents.
 * A corpus-content digest replaces it at corpus freeze in a MINOR release.
 */
export const ARS_CORPUS_HASH = sha256Hex('ars-0.2-corpus-unfrozen')

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/** One entry of a `Link` header: the target IRI plus the parameters ARS reads. */
interface ParsedLink {
  readonly url: string
  readonly rel: readonly string[]
  readonly type: string | null
}

/**
 * Parses `Link` header values (RFC 8288) in the subset ARS scores: the target
 * IRI, `rel` as a token list, and `type`.
 *
 * Written as a scanner because the separator is a comma and target IRIs contain
 * commas — `<https://x/a,b>; rel="alternate"` is one link, not two. Splitting on
 * `,` would silently drop half of the alternates a merchant declared and cost
 * them 4 points on D2.2.
 */
export function parseLinkHeaders(values: readonly string[]): ParsedLink[] {
  const out: ParsedLink[] = []
  for (const value of values) {
    for (const entry of splitLinkEntries(value)) {
      const open = entry.indexOf('<')
      const close = entry.indexOf('>', open + 1)
      if (open === -1 || close === -1) continue
      const url = entry.slice(open + 1, close).trim()
      if (url.length === 0) continue
      let rel: string[] = []
      let type: string | null = null
      for (const param of entry.slice(close + 1).split(';')) {
        const equals = param.indexOf('=')
        if (equals === -1) continue
        const name = param.slice(0, equals).trim().toLowerCase()
        const raw = param.slice(equals + 1).trim()
        const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
        if (name === 'rel')
          rel = unquoted
            .toLowerCase()
            .split(/\s+/)
            .filter((t) => t.length > 0)
        else if (name === 'type') type = unquoted.trim().toLowerCase()
      }
      out.push({ url, rel, type })
    }
  }
  return out
}

/** Splits on commas that are outside `<…>` and outside a quoted string. */
function splitLinkEntries(value: string): string[] {
  const entries: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i)
    if (quoted) {
      if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '<') depth++
    else if (char === '>') depth = depth > 0 ? depth - 1 : 0
    else if (char === ',' && depth === 0) {
      entries.push(value.slice(start, i))
      start = i + 1
    }
  }
  entries.push(value.slice(start))
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/** Comma/space-separated header token list, lowercased. */
function headerTokens(value: string | null): string[] {
  if (value === null) return []
  return value
    .toLowerCase()
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

// ---------------------------------------------------------------------------
// Scoring context
// ---------------------------------------------------------------------------

/** Everything the 22 checks read, computed exactly once. */
interface ScoreContext {
  readonly evidence: ArsEvidence
  readonly ruleset: ArsRuleset
  readonly agentCapture: ArsHttpCapture
  readonly browserCapture: ArsHttpCapture | null
  readonly agent: ArsRepresentation
  readonly browser: ArsRepresentation | null
  /** The representation that carries a tokenized document, if either does. */
  readonly structural: ArsRepresentation | null
  readonly classification: ArsClassification
  readonly profile: ArsFactProfile
  readonly facts: readonly MergedFact[]
  readonly agentFacts: readonly ExtractedFact[]
  readonly browserFacts: readonly ExtractedFact[]
  readonly structuralFacts: readonly ExtractedFact[]
  readonly policy: ArsPolicyReport
  readonly robots: RobotsFile | null
  readonly flags: ArsFlag[]
}

interface CheckOutcome {
  readonly earned: number
  readonly evidence: ArsCheckEvidence[]
  readonly remedy?: string
}

const YES = 'yes'
const NO = 'no'
const yesNo = (value: boolean): string => (value ? YES : NO)

function measured(label: string, value: string): ArsCheckEvidence {
  return { label, value, basis: 'measured' }
}

function heuristic(label: string, value: string): ArsCheckEvidence {
  return { label, value, basis: 'heuristic' }
}

// ---------------------------------------------------------------------------
// D1 — Retrievability
// ---------------------------------------------------------------------------

function checkReachable(context: ScoreContext): CheckOutcome {
  const { agentCapture, browserCapture, ruleset } = context
  const split = SUBPOINTS.reachable
  const status2xx = agentCapture.status >= 200 && agentCapture.status < 300
  const hops = agentCapture.redirects.length
  const withinLimit = hops <= ruleset.maxRedirects
  const sameFinalUrl = browserCapture !== null && browserCapture.finalUrl === agentCapture.finalUrl

  const earned =
    (status2xx ? split.status2xx : 0) +
    (withinLimit ? split.withinRedirectLimit : 0) +
    (sameFinalUrl ? split.noAcceptConditionalRedirect : 0)

  const evidence = [
    measured('HTTP status on the agent path', String(agentCapture.status)),
    measured('Redirect hops', `${hops} (limit ${ruleset.maxRedirects})`),
    measured(
      'Both probes resolved to the same URL',
      browserCapture === null
        ? 'not comparable — no browser-control capture in this bundle'
        : yesNo(sameFinalUrl),
    ),
  ]
  return sameFinalUrl
    ? { earned, evidence }
    : {
        earned,
        evidence,
        remedy:
          'Serve the same URL to both Accept headers. An Accept-conditional redirect sends the agent somewhere the browser never goes, and caches key on the URL.',
      }
}

function checkRobotsPolicy(context: ScoreContext): CheckOutcome {
  const { policy, robots } = context
  const split = SUBPOINTS.robotsPolicy
  const decision = policy.audiences.assistant
  const parsesClean = robots === null || robots.malformedLines === 0
  const noOrphanRules = robots === null || robots.orphanRules === 0

  const evidence = [
    measured('robots.txt', policy.robotsTxtStatus),
    measured(
      'Assistant audience',
      decision.matchedGroup === null
        ? `${decision.decision} (no matching group)`
        : `${decision.decision} via User-agent: ${decision.matchedGroup}${
            decision.matchedRule === null ? '' : ` / ${decision.matchedRule}`
          }`,
    ),
    measured('Malformed lines', robots === null ? 'n/a' : String(robots.malformedLines)),
    measured(
      'Rules before any User-agent line',
      robots === null ? 'n/a' : String(robots.orphanRules),
    ),
    measured('Sitemap: declared', yesNo(policy.sitemapDeclared)),
    measured(
      'Training-crawler policy (never scored)',
      policy.trainingOptOut ? 'blocked — neutral, no effect on this score' : 'allowed',
    ),
  ]

  // §3.7: an accidental or ambiguous assistant disallow — a blanket group, a
  // malformed file — is SCORED, with D1.2 at zero and a `robots-contradiction`
  // warning. It is not an opt-out, because consent has to be specific.
  if (decision.decision === 'disallow') {
    context.flags.push({
      id: 'robots-contradiction',
      severity: 'warn',
      basis: 'measured',
      message:
        'robots.txt disallows assistant crawlers through a group that does not name one, so it reads as a blanket rule rather than a deliberate choice. Assistant traffic is blocked as a side effect.',
      evidence: [evidence[1] ?? measured('Assistant audience', decision.decision)],
    })
    return {
      earned: 0,
      evidence,
      remedy:
        'Name the assistant crawlers you mean to allow or block in their own robots.txt group. A blanket disallow blocks assistant fetches that users triggered on purpose.',
    }
  }

  const earned =
    split.assistantAllowed +
    (parsesClean ? split.parsesClean : 0) +
    (noOrphanRules ? split.noOrphanRules : 0) +
    (policy.sitemapDeclared ? split.sitemapDeclared : 0)

  return {
    earned,
    evidence,
    remedy: policy.sitemapDeclared
      ? undefined
      : 'Add a `Sitemap:` line to robots.txt. It is the one place an agent looks to find the rest of the site.',
  }
}

function checkRenderIndependence(context: ScoreContext): CheckOutcome {
  const { structural, structuralFacts, profile } = context
  const split = SUBPOINTS.renderIndependence
  const coreSize = profile.core.length

  if (structural === null || structural.doc === null) {
    return {
      earned: 0,
      evidence: [heuristic('HTML representation', 'none in this bundle — not evaluated')],
    }
  }

  const found = new Set<ArsFactKind>()
  for (const fact of structuralFacts) if (profile.core.includes(fact.kind)) found.add(fact.kind)
  const ratio = coreSize === 0 ? 0 : idiv(100 * found.size, coreSize)

  let noscriptText = ''
  for (const element of structural.doc.elements) {
    if (element.tag !== 'noscript') continue
    noscriptText = elementText(structural.doc, element.index).trim()
    if (noscriptText.length > 0) break
  }
  const hasNoscript = noscriptText.length > 0

  const banded = atLeast(split.band, ratio)
  const earned = Math.max(banded, hasNoscript ? split.noscriptFloor : 0)
  const full = atLeast(split.band, 100)

  if (ratio < 50) {
    context.flags.push({
      id: 'render-dependent',
      severity: 'info',
      basis: 'heuristic',
      message: `${found.size} of ${coreSize} core facts for this page kind were present in the HTML without running JavaScript. A caller that does not execute scripts sees the rest as missing.`,
      evidence: [heuristic('Core facts in the served HTML', `${found.size}/${coreSize}`)],
    })
  }

  return {
    earned,
    evidence: [
      heuristic('Core facts present without JavaScript', `${found.size}/${coreSize}`),
      heuristic('<noscript> fallback with content', yesNo(hasNoscript)),
      heuristic(
        'Basis',
        'inferred — ARS never executes JavaScript, so this measures the served HTML, not what a browser would render',
      ),
    ],
    remedy:
      earned === full
        ? undefined
        : 'Render the core facts for this page kind into the HTML the server sends. Agents do not run your JavaScript.',
  }
}

// ---------------------------------------------------------------------------
// D2 — Machine representation
// ---------------------------------------------------------------------------

/** Media types that count as a machine representation for D2.1 (§3.4). */
const MACHINE_KINDS: ReadonlySet<ArsRepresentation['kind']> = new Set(['markdown', 'text', 'json'])

function checkNegotiatedResponse(context: ScoreContext): CheckOutcome {
  const { agent } = context
  const typeIsMachine = MACHINE_KINDS.has(agent.kind)
  const bodyIsHtml = agent.looksLikeHtml
  const earned = typeIsMachine && !bodyIsHtml ? SUBPOINTS.negotiatedResponse.full : 0

  return {
    earned,
    evidence: [
      measured('Content-Type on the agent probe', agent.contentType ?? 'absent'),
      measured('Body is HTML', yesNo(bodyIsHtml)),
      measured(
        'Request Accept header',
        context.evidence.probes.agent.requestHeaders['accept'] ??
          context.evidence.probes.agent.requestHeaders['Accept'] ??
          'not recorded',
      ),
    ],
    remedy:
      earned > 0
        ? undefined
        : typeIsMachine
          ? 'The response declared a machine media type but the body is HTML. Send the representation the Content-Type promises.'
          : 'Return a machine representation — Markdown, plain text or JSON — when the request Accept header asks for one, with a matching Content-Type.',
  }
}

function checkDeclaredAlternates(context: ScoreContext): CheckOutcome {
  const { agentCapture, browserCapture, structural } = context
  const links = parseLinkHeaders([
    ...headerAll(agentCapture.headers, 'link'),
    ...(browserCapture === null ? [] : headerAll(browserCapture.headers, 'link')),
  ])
  // An alternate with no `type` is a language variant (`hreflang`), not a second
  // representation. Every international site declares those, and paying 4 points
  // for them would make the check meaningless.
  const headerAlternates = links.filter(
    (link) => link.rel.includes('alternate') && link.type !== null,
  )

  const documentAlternates: string[] = []
  if (structural !== null && structural.doc !== null) {
    for (const link of structural.doc.links) {
      if (!link.rel.includes('alternate')) continue
      if (link.type === null || link.href === null) continue
      documentAlternates.push(`${link.type} → ${link.href}`)
    }
  }

  const total = headerAlternates.length + documentAlternates.length
  return {
    earned: total > 0 ? SUBPOINTS.declaredAlternates.full : 0,
    evidence: [
      measured(
        'Link: rel="alternate" (typed)',
        headerAlternates.length === 0
          ? 'none'
          : headerAlternates.map((link) => `${link.type ?? '?'} → ${link.url}`).join(', '),
      ),
      measured(
        '<link rel="alternate"> (typed)',
        documentAlternates.length === 0 ? 'none' : documentAlternates.join(', '),
      ),
    ],
    remedy:
      total > 0
        ? undefined
        : 'Declare the machine representation: `Link: <…>; rel="alternate"; type="text/markdown"` or a `<link rel="alternate">` in the HTML. An endpoint an agent cannot find is an endpoint that does not exist.',
  }
}

function checkVaryAccept(context: ScoreContext, negotiated: number): CheckOutcome {
  const { agentCapture, browserCapture } = context
  const agentVary = headerTokens(header(agentCapture.headers, 'vary'))
  const browserVary =
    browserCapture === null ? [] : headerTokens(header(browserCapture.headers, 'vary'))
  const declared = agentVary.includes('accept') || browserVary.includes('accept')

  const evidence = [
    measured('Vary on the agent response', header(agentCapture.headers, 'vary') ?? 'absent'),
    measured(
      'Vary on the browser response',
      browserCapture === null
        ? 'no browser capture'
        : (header(browserCapture.headers, 'vary') ?? 'absent'),
    ),
  ]

  // Gated on D2.1: `Vary: Accept` on a response that does not vary by Accept is
  // a claim about caching that is not true. Fixture 035 pins it.
  if (negotiated === 0) {
    return {
      earned: 0,
      evidence: [
        ...evidence,
        measured(
          'Scored',
          'no — this check is 0 unless a machine representation was served (D2.1)',
        ),
      ],
    }
  }

  if (!declared) {
    context.flags.push({
      id: 'vary-missing',
      severity: 'warn',
      basis: 'measured',
      message:
        'The same URL returns different representations by Accept but does not send `Vary: Accept`. A shared cache can serve the Markdown to a browser, or the HTML to an agent.',
      evidence,
    })
  }

  return {
    earned: declared ? SUBPOINTS.varyAccept.full : 0,
    evidence,
    remedy: declared
      ? undefined
      : 'Send `Vary: Accept` on every response from a URL that negotiates on Accept.',
  }
}

/**
 * The kinds D2.4 compares. Explicitly four, and never description or free text
 * (§3.8): a prose difference between a Markdown summary and an HTML page is a
 * rendering difference, and calling it a substance divergence would be an
 * accusation we cannot support.
 */
const PARITY_KINDS: readonly ArsFactKind[] = ['price', 'currency', 'availability', 'title']

/**
 * Two readings of one side's facts: the value it would PUBLISH for each kind
 * (the unqualified observation with the lowest byte offset, ties broken
 * lexicographically — the same choice `mergeFacts` makes for the published fact
 * set), and EVERY unqualified value it stated.
 *
 * Qualified values — ranges, "from $9" — never enter either map (§3.11).
 */
interface FactView {
  readonly representative: Map<ArsFactKind, string>
  readonly observed: Map<ArsFactKind, Set<string>>
}

function factView(facts: readonly ExtractedFact[]): FactView {
  const best = new Map<ArsFactKind, ExtractedFact>()
  const observed = new Map<ArsFactKind, Set<string>>()
  for (const fact of facts) {
    if (fact.qualified) continue
    const seen = observed.get(fact.kind)
    if (seen === undefined) observed.set(fact.kind, new Set([fact.normalized]))
    else seen.add(fact.normalized)

    const current = best.get(fact.kind)
    if (current === undefined) {
      best.set(fact.kind, fact)
      continue
    }
    if (fact.offset < current.offset) best.set(fact.kind, fact)
    else if (fact.offset === current.offset && fact.normalized < current.normalized)
      best.set(fact.kind, fact)
  }
  const representative = new Map<ArsFactKind, string>()
  for (const [kind, fact] of best) representative.set(kind, fact.normalized)
  return { representative, observed }
}

/**
 * The comparison rule for D2.4 and D5.3, and it is ASYMMETRIC on purpose:
 * **the value the left side would publish must appear somewhere among the values
 * the right side stated.**
 *
 * Both symmetric rules are wrong, and each is wrong in a way that matters:
 *
 * - Requiring the two REPRESENTATIVES to be equal produces false accusations on
 *   ordinary pages. The demo product page in fixtures 001/002 names a backordered
 *   variant above the line that says the product is in stock; its JSON-LD says
 *   `InStock`, and both statements are true. Flagging that as a
 *   structured-data divergence would be an accusation the evidence does not
 *   support, and ARS reports observations rather than charges (§3.8).
 * - Accepting ANY shared value lets a real divergence hide behind an incidental
 *   match: "Free shipping over $50" appears in both representations, so a page
 *   whose headline price differs would still certify clean.
 *
 * The asymmetric rule catches the second and not the first, which is the
 * conservative direction: a missed divergence costs a merchant nothing, and a
 * false one is published on a scanner page next to their name.
 */
function divergentKinds(
  left: FactView,
  right: FactView,
  kinds: readonly ArsFactKind[],
): { compared: ArsFactKind[]; divergent: { kind: ArsFactKind; left: string; right: string }[] } {
  const compared: ArsFactKind[] = []
  const divergent: { kind: ArsFactKind; left: string; right: string }[] = []
  for (const kind of kinds) {
    const claim = left.representative.get(kind)
    const stated = right.observed.get(kind)
    if (claim === undefined || stated === undefined || stated.size === 0) continue
    compared.push(kind)
    if (!stated.has(claim)) {
      divergent.push({ kind, left: claim, right: [...stated].sort().join(' | ') })
    }
  }
  return { compared, divergent }
}

function checkSubstanceParity(context: ScoreContext, negotiated: number): CheckOutcome {
  const { agentFacts, browserFacts, browser, evidence: bundle } = context

  if (negotiated === 0 || browser === null) {
    return {
      earned: 0,
      evidence: [
        heuristic(
          'Comparable',
          negotiated === 0
            ? 'no — there is one representation, so there is nothing to compare (this is the designed 84-point ceiling for a page with no content negotiation)'
            : 'no — no browser-control capture in this bundle',
        ),
      ],
    }
  }

  const agentValues = factView(agentFacts)
  const browserValues = factView(browserFacts)
  const { compared, divergent } = divergentKinds(agentValues, browserValues, PARITY_KINDS)

  const evidenceLines = [
    heuristic(
      'Compared facts',
      compared.length === 0 ? 'none present in both representations' : compared.join(', '),
    ),
    heuristic(
      'Values',
      divergent.length === 0
        ? 'agree'
        : divergent
            .map((entry) => `${entry.kind}: agent ${entry.left} / HTML ${entry.right}`)
            .join('; '),
    ),
  ]

  if (compared.length === 0) {
    return {
      earned: 0,
      evidence: [
        ...evidenceLines,
        heuristic(
          'Scored',
          'no — a comparison needs at least one comparable fact in both representations',
        ),
      ],
      remedy:
        'State the same core facts in both representations. ARS could not compare them, so it could not award the parity points.',
    }
  }

  if (divergent.length === 0)
    return { earned: SUBPOINTS.substanceParity.full, evidence: evidenceLines }

  // §3.8: divergence must REPRODUCE on a third confirming probe taken ≥30s later
  // before the flag is set. Inventory and price genuinely change between two
  // sequential requests, and a one-shot difference is not evidence of anything.
  const confirm = bundle.probes.parityConfirm
  const confirmCapture = confirm !== null && confirm.result.ok ? confirm.result.capture : null
  const confirmRep = confirmCapture === null ? null : buildRepresentation(confirmCapture)
  if (confirmRep === null) {
    return {
      earned: 0,
      evidence: [
        ...evidenceLines,
        heuristic('Confirming probe', 'absent — divergence observed once and NOT flagged'),
      ],
      remedy:
        'The two representations reported different values for a core fact. ARS did not flag it, because a single observation cannot distinguish a divergence from an inventory change.',
    }
  }

  const confirmFacts = extractFacts(confirmRep, {
    profile: context.profile,
    ruleset: context.ruleset,
    baseUrl: confirmRep.finalUrl,
    origin: bundle.target.origin,
    currencyHint: currencyHintOf(context.structural, context.agent),
  })
  const confirmValues = factView(confirmFacts)
  const reproduced = divergentKinds(
    confirmValues,
    browserValues,
    divergent.map((entry) => entry.kind),
  )

  if (reproduced.divergent.length === 0) {
    return {
      earned: SUBPOINTS.substanceParity.full,
      evidence: [
        ...evidenceLines,
        heuristic(
          'Confirming probe',
          'the difference did not reproduce — treated as a value that changed between requests',
        ),
      ],
    }
  }

  context.flags.push({
    id: 'substance-divergence',
    severity: 'warn',
    basis: 'heuristic',
    message: reproduced.divergent
      .map(
        (entry) =>
          `The agent representation reported ${entry.kind} ${entry.left}; the HTML representation reported ${entry.right} at capture time, on two captures taken apart.`,
      )
      .join(' '),
    evidence: evidenceLines,
  })

  return {
    earned: 0,
    evidence: [...evidenceLines, heuristic('Confirming probe', 'the difference reproduced')],
    remedy:
      'Serve the same values in both representations. ARS reports what each one said; it does not assert which is correct.',
  }
}

// ---------------------------------------------------------------------------
// D3 — Fact coverage
// ---------------------------------------------------------------------------

interface CoverageMath {
  readonly coreFound: number
  readonly extendedFound: number
  readonly coveragePct: number
  readonly densityPct: number
  readonly factsPerKiB100: number
}

/** §3.6's fact weighting, verbatim, in quarter-units. */
function coverageMath(context: ScoreContext): CoverageMath {
  const { facts, profile, ruleset, agent } = context
  const units = ruleset.thresholds['fact-coverage.fact-units'] ?? []
  const coreCorroboratedUnit = units[0] ?? 0
  const coreUnit = units[1] ?? 0
  const extendedCorroboratedUnit = units[2] ?? 0
  const extendedUnit = units[3] ?? 0
  const denominatorMultiplier =
    ruleset.thresholds['fact-coverage.core-denominator-multiplier']?.[0] ?? 0

  let coreUnits = 0
  let extendedUnits = 0
  let coreFound = 0
  let extendedFound = 0
  for (const fact of facts) {
    if (profile.core.includes(fact.kind)) {
      coreFound++
      coreUnits += fact.corroborated ? coreCorroboratedUnit : coreUnit
    } else if (profile.extended.includes(fact.kind)) {
      extendedFound++
      extendedUnits += fact.corroborated ? extendedCorroboratedUnit : extendedUnit
    }
  }

  const denominator = denominatorMultiplier * profile.core.length
  const coveragePct =
    denominator === 0
      ? 0
      : Math.min(100, divRoundHalfUp(100 * (coreUnits + extendedUnits), denominator))

  // The `max(1, bytes)` clamp is normative and replaces `max(1, bytes / 1024)`,
  // which let a 200-byte stub top the density band.
  const factsPerKiB100 = idiv(
    (coreFound * 100 + extendedFound * 25) * 1024,
    Math.max(1, agent.bytes),
  )
  const densityPct = atLeast(ruleset.thresholds['fact-coverage.density'], factsPerKiB100)

  return { coreFound, extendedFound, coveragePct, densityPct, factsPerKiB100 }
}

function checkCoreFacts(context: ScoreContext, math: CoverageMath): CheckOutcome {
  const weight = weightOf(context.ruleset, 'fact-coverage.core-facts')
  const earned = idiv(weight * math.coveragePct * math.densityPct + 5000, 10000)
  const missing = context.profile.core.filter(
    (kind) => !context.facts.some((fact) => fact.kind === kind),
  )

  return {
    earned,
    evidence: [
      heuristic(
        'Core facts found',
        `${math.coreFound}/${context.profile.core.length}${missing.length === 0 ? '' : ` — missing ${missing.join(', ')}`}`,
      ),
      heuristic('Extended facts found', `${math.extendedFound}/${context.profile.extended.length}`),
      heuristic('Coverage', `${math.coveragePct}%`),
      heuristic(
        'Density band',
        `${math.densityPct}% (${math.factsPerKiB100} hundredths of a fact per KiB)`,
      ),
      measured('Bytes the agent received', String(context.agent.bytes)),
    ],
    remedy:
      missing.length === 0
        ? undefined
        : `State ${missing.join(', ')} in the representation the agent receives. A fact only the HTML carries is a fact the caller never saw.`,
  }
}

function checkContextCost(context: ScoreContext): CheckOutcome {
  const table = context.ruleset.thresholds['fact-coverage.context-cost']
  const reference = context.profile.byteReference
  const ratio = reference === 0 ? 0 : idiv(100 * context.agent.bytes, reference)
  const earned = atMost(table, ratio)
  const full = atMost(table, 0)

  return {
    earned,
    evidence: [
      measured(
        'Bytes the agent received',
        `${context.agent.bytes}${context.agent.truncated ? ' (truncated at the cap)' : ''}`,
      ),
      measured('Byte reference for this page kind', `${reference} (${context.profile.pageKind})`),
      measured('Ratio', `${ratio}% of the reference`),
    ],
    remedy:
      earned === full
        ? undefined
        : 'Serve a representation sized to the facts. The reference is what a page of this kind reasonably costs, not an absolute budget.',
  }
}


// ---------------------------------------------------------------------------
// D7 — Evidence density
// ---------------------------------------------------------------------------

/**
 * WHY THIS DIMENSION EXISTS (ARS 0.2). The controlled work on what an assistant
 * actually lifts into an answer, rather than what it merely cites, finds the
 * effect concentrated in extractable evidence units: quantities, definitions
 * and comparisons carry large influence uplift, while conversational Q&A
 * phrasing carries none. D1-D6 grade whether an agent can REACH and PARSE a
 * page. Nothing before this graded whether, having parsed it, there was
 * anything quotable on it.
 *
 * ALL THREE ARE COUNTS OVER THE AGENT'S OWN COUNTED TEXT. No model, no
 * randomness, no clock. `quantities` and `comparisons` are `measured` because
 * they observe the artifact directly, a token shape and a markup structure;
 * `definitions` is `heuristic` because calling a `label: value` line a
 * definition is a judgement about intent, and the basis field says so.
 */

/** Currency amount, percentage, number carrying a unit, or an ISO date. */
const QUANTITY = new RegExp(
  [
    String.raw`[$£€¥]\s?\d[\d,]*(?:\.\d+)?`,
    String.raw`\d[\d,]*(?:\.\d+)?\s?%`,
    String.raw`\d[\d,]*(?:\.\d+)?\s?(?:kg|g|lb|lbs|oz|mm|cm|m|km|mi|in|ft|ml|l|kb|mb|gb|tb|hz|w|kw|v|°c|°f|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?)\b`,
    String.raw`\d{4}-\d{2}-\d{2}`,
  ].join('|'),
  'giu',
)

/** `**Label:** value`, `- Label: value`, and `<dt>` rows once tokenized to text. */
const DEFINITION_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?[A-Za-z][A-Za-z0-9 /&'()-]{1,40}(?:\*\*)?\s*:\s*\S/

/**
 * Block elements that hold ONE labelled fact when a page states them in markup
 * rather than in Markdown. Pinned, like every other table in this standard.
 *
 * WHY THIS SET EXISTS AT ALL. `countedText` joins every text node with a single
 * space and collapses whitespace runs, so an HTML document's counted text is one
 * line — deliberately, because a line model would need a display model and there
 * is no CSS resolution anywhere in this package. Splitting D7.2 on `\n` would
 * therefore score EVERY HTML page at zero and pay only representations that
 * arrive already line-structured, which in practice means pages behind a
 * Markdown gateway. A check that only the editors' own product can satisfy is
 * exactly the self-serving design this standard must not contain, so D7.2
 * segments an HTML document structurally instead: each counted text node is
 * attributed to its nearest ancestor in this set, and each such element's own
 * text is one candidate line. Innermost wins by construction, so a `<p>` inside
 * an `<li>` is counted once and not twice.
 */
const LABELLED_BLOCK_TAGS = new Set(['li', 'dt', 'dd', 'p', 'td', 'th', 'div'])

function checkQuantities(context: ScoreContext): CheckOutcome {
  const table = context.ruleset.thresholds['evidence-density.quantities']
  // DISTINCT, normalized on case and inner whitespace: a price stated in a
  // header, a buy box and a footer is one fact said three times, and paying
  // for the repetition would reward exactly the padding this score exists to
  // discourage.
  const seen = new Set<string>()
  for (const match of context.agent.text.matchAll(QUANTITY)) {
    seen.add(match[0].toLowerCase().replace(/\s+/g, ''))
  }
  const count = seen.size
  const earned = atLeast(table, count)
  const full = atLeast(table, Number.MAX_SAFE_INTEGER)

  return {
    earned,
    evidence: [measured('Distinct quantities an answer could quote', `${count}`)],
    remedy:
      earned === full
        ? undefined
        : 'State the numbers a reader would ask for, in text: price, sizes, hours, fees, dates. A quantity an agent can lift is what a cited answer is built from.',
  }
}

/**
 * The candidate lines of a representation: one per labelled block element when
 * there is a document, and the text's own lines when there is not. Order is
 * document order in both cases, so two runs over one bundle agree.
 */
function labelledSegments(context: ScoreContext): string[] {
  const doc = context.agent.doc
  if (doc === null) return context.agent.text.split('\n')

  // One pass over counted text nodes, each attributed to its nearest ancestor
  // in LABELLED_BLOCK_TAGS. `Map` preserves insertion order, which is the order
  // the first text node of each element appeared.
  const byElement = new Map<number, string[]>()
  for (const node of doc.texts) {
    if (node.excludedBy !== null) continue
    if (node.text.trim().length === 0) continue
    let at = node.parent
    // Bounded by the tokenizer's own depth limit; a cycle cannot hang this.
    for (let hops = 0; at >= 0 && hops <= MAX_ANCESTOR_HOPS; hops += 1) {
      const element = doc.elements[at]
      if (element === undefined) break
      if (LABELLED_BLOCK_TAGS.has(element.tag)) {
        const parts = byElement.get(at)
        if (parts === undefined) byElement.set(at, [node.text])
        else parts.push(node.text)
        break
      }
      at = element.parent
    }
  }

  const segments: string[] = []
  for (const parts of byElement.values()) {
    segments.push(parts.join(' ').replace(/\s+/g, ' ').trim())
  }
  return segments
}

/** Deep enough for any real document; the tokenizer caps nesting well below it. */
const MAX_ANCESTOR_HOPS = 256

function checkDefinitions(context: ScoreContext): CheckOutcome {
  const table = context.ruleset.thresholds['evidence-density.definitions']
  let count = 0
  for (const line of labelledSegments(context)) {
    if (DEFINITION_LINE.test(line)) count += 1
  }
  const earned = atLeast(table, count)
  const full = atLeast(table, Number.MAX_SAFE_INTEGER)

  return {
    earned,
    evidence: [heuristic('Labelled term and value pairs', `${count}`)],
    remedy:
      earned === full
        ? undefined
        : 'Label your facts. A line that reads "Returns: 60 days" is liftable whole; the same fact inside a paragraph has to be inferred.',
  }
}

/**
 * Comparable ROWS, not tables. A table with one data row states a fact; two or
 * more let an assistant contrast options, which is the shape the absorption
 * work found doing the work. Counted from the tokenized document so it is a
 * structural observation, and from the markdown pipe form when there is no
 * document, so a markdown-only representation is not silently scored zero.
 */
function checkComparisons(context: ScoreContext): CheckOutcome {
  const table = context.ruleset.thresholds['evidence-density.comparisons']
  let rows = 0

  const doc = context.agent.doc
  if (doc !== null) {
    // Cells per row, by walking children back to their parent `tr`. The
    // tokenizer records `parent` as an index into `elements`, so this is one
    // pass and no tree is built.
    const cellsByRow = new Map<number, number>()
    for (const element of doc.elements) {
      if (element.tag !== 'td' && element.tag !== 'th') continue
      const row = doc.elements[element.parent]
      if (row === undefined || row.tag !== 'tr') continue
      cellsByRow.set(element.parent, (cellsByRow.get(element.parent) ?? 0) + 1)
    }
    for (const cells of cellsByRow.values()) if (cells >= 2) rows += 1
    // A header row is not a comparison.
    rows = Math.max(0, rows - 1)
  } else {
    let pipeRows = 0
    for (const line of context.agent.text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue // the alignment rule
      if (trimmed.split('|').length - 2 >= 2) pipeRows += 1
    }
    rows = Math.max(0, pipeRows - 1)
  }

  const earned = atLeast(table, rows)
  const full = atLeast(table, Number.MAX_SAFE_INTEGER)

  return {
    earned,
    evidence: [measured('Comparable rows', `${rows}`)],
    remedy:
      earned === full
        ? undefined
        : 'Put options side by side in a table with a row each. An assistant comparing two things reaches for rows it can line up.',
  }
}

// ---------------------------------------------------------------------------
// D4 — Fact position
// ---------------------------------------------------------------------------

function coreOffsets(context: ScoreContext): number[] {
  const offsets: number[] = []
  for (const fact of context.facts)
    if (context.profile.core.includes(fact.kind)) offsets.push(fact.offset)
  return offsets.sort((a, b) => a - b)
}

function checkFirstCoreFactOffset(context: ScoreContext, offsets: readonly number[]): CheckOutcome {
  const first = offsets[0]
  if (first === undefined) {
    return {
      earned: 0,
      evidence: [heuristic('First core fact', 'none found — nothing to position')],
    }
  }
  return {
    earned: atMost(context.ruleset.thresholds['fact-position.first-core-fact-offset'], first),
    evidence: [
      measured('Byte offset of the first core fact', String(first)),
      heuristic(
        'Which fact',
        context.facts.find((fact) => fact.offset === first)?.kind ?? 'unknown',
      ),
    ],
    remedy:
      first <= 512
        ? undefined
        : 'Move the core facts to the top of the representation. A caller that stops reading early stops before them.',
  }
}

function checkFrontWindow(context: ScoreContext, offsets: readonly number[]): CheckOutcome {
  const windowRule = context.ruleset.thresholds['fact-position.front-window-size'] ?? []
  const floor = windowRule[0] ?? 0
  const divisor = windowRule[1] ?? 1
  const size = Math.max(floor, idiv(context.agent.bytes, divisor))

  if (offsets.length === 0) {
    return {
      earned: 0,
      evidence: [
        measured('Front window', `${size} bytes`),
        heuristic('Core facts inside it', 'none found — nothing to position'),
      ],
    }
  }

  const inside = offsets.filter((offset) => offset < size).length
  // The denominator is the core facts that are PRESENT, not the profile size:
  // absence is D3.1's job, and charging the same absence twice would make the
  // 100 points non-orthogonal. The evidence prints both numbers so a reader can
  // see which question was asked.
  const pct = idiv(100 * inside, offsets.length)

  return {
    earned: atLeast(context.ruleset.thresholds['fact-position.front-window'], pct),
    evidence: [
      measured('Front window', `${size} bytes (max(${floor}, bytes/${divisor}))`),
      heuristic('Core facts inside it', `${inside}/${offsets.length} found (${pct}%)`),
      heuristic('Core facts in this page kind', String(context.profile.core.length)),
    ],
    remedy:
      pct >= 90
        ? undefined
        : 'Front-load the core facts. Everything after the window costs the caller a full read.',
  }
}

// ---------------------------------------------------------------------------
// D5 — Structured data
// ---------------------------------------------------------------------------

function checkStructuredDataPresent(context: ScoreContext): CheckOutcome {
  const { structural } = context
  const split = SUBPOINTS.structuredDataPresent
  if (structural === null) {
    return {
      earned: 0,
      evidence: [measured('HTML representation', 'none in this bundle — not evaluated')],
    }
  }

  const { blocks, parsed } = structural.jsonLd
  let microdata = 0
  let rdfa = 0
  if (structural.doc !== null) {
    for (const element of structural.doc.elements) {
      if (attr(element, 'itemtype') !== null) microdata++
      if (attr(element, 'typeof') !== null) rdfa++
    }
  }

  const jsonLdScore =
    blocks === 0 ? null : parsed === blocks ? split.clean : parsed > 0 ? split.partial : 0
  const otherScore = microdata > 0 || rdfa > 0 ? split.clean : null
  const earned = Math.max(jsonLdScore ?? 0, otherScore ?? 0)

  return {
    earned,
    evidence: [
      measured('JSON-LD blocks', `${parsed} of ${blocks} parsed`),
      measured('Microdata itemtype scopes', String(microdata)),
      measured('RDFa typeof scopes', String(rdfa)),
    ],
    remedy:
      earned === split.clean
        ? undefined
        : blocks > parsed
          ? 'One or more JSON-LD blocks did not parse. A block that does not parse is not structured data.'
          : 'Add JSON-LD for this page. It is the one machine representation every consumer already reads.',
  }
}

/**
 * The JSON-LD node D5.2 scores against: the node whose `@type` decided the page
 * kind, then any node with a recognised type. Scoring the first node in the
 * document would mark a page incomplete because its `BreadcrumbList` has no
 * `offers.price` (§ `nodeForKind` in ./classify).
 */
function scoredNode(context: ScoreContext): JsonLdNode | null {
  const nodes = context.structural?.jsonLd.nodes ?? []
  const forKind = nodeForKind(nodes, context.profile.pageKind)
  if (forKind !== null) return forKind
  for (const node of nodes) if (node.types.some(isRecognisedType)) return node
  return null
}

function checkRequiredProperties(context: ScoreContext): CheckOutcome {
  const split = SUBPOINTS.requiredProperties
  const required = context.ruleset.requiredProperties[context.profile.pageKind] ?? []
  const node = scoredNode(context)

  if (node === null) {
    return {
      earned: 0,
      evidence: [
        measured('Recognised schema.org type', 'none'),
        measured('Required properties for this page kind', required.join(', ') || 'none'),
        measured(
          'Scope',
          'JSON-LD only in 0.1 — microdata satisfies D5.1 but is not walked for required properties',
        ),
      ],
      remedy:
        'Declare a schema.org type in JSON-LD. Choosing no type does not avoid this check — an unrecognised page still scores against "any recognised type present".',
    }
  }

  const satisfied = required.filter((path) => hasPath(node, path))
  const missing = required.filter((path) => !hasPath(node, path))
  const completeness =
    required.length === 0
      ? split.completeness
      : divRoundHalfUp(split.completeness * satisfied.length, required.length)

  return {
    earned: split.recognisedType + completeness,
    evidence: [
      measured('Scored node @type', node.types.join(', ')),
      measured(
        'Required properties',
        `${satisfied.length}/${required.length}${missing.length === 0 ? '' : ` — missing ${missing.join(', ')}`}`,
      ),
      measured('Table', `ruleset.requiredProperties.${context.profile.pageKind}`),
    ],
    remedy:
      missing.length === 0
        ? undefined
        : `Add ${missing.join(', ')} to the ${node.types[0] ?? 'top-level'} node.`,
  }
}

function checkTextAgreement(context: ScoreContext): CheckOutcome {
  const { structuralFacts } = context
  const fromJsonLd = factView(structuralFacts.filter((fact) => fact.source === 'json-ld'))
  const fromPage = factView(structuralFacts.filter((fact) => fact.source !== 'json-ld'))
  const { compared, divergent } = divergentKinds(fromJsonLd, fromPage, PARITY_KINDS)

  const evidenceLines = [
    heuristic(
      'Compared facts',
      compared.length === 0
        ? 'none stated both in structured data and on the page'
        : compared.join(', '),
    ),
    heuristic(
      'Values',
      divergent.length === 0
        ? 'agree'
        : divergent
            .map((entry) => `${entry.kind}: structured data ${entry.left} / page ${entry.right}`)
            .join('; '),
    ),
  ]

  if (compared.length === 0) {
    return {
      earned: 0,
      evidence: [...evidenceLines, heuristic('Scored', 'no — nothing was comparable')],
      remedy:
        'State the core facts in both the structured data and the visible page, so the two can be checked against each other.',
    }
  }

  if (divergent.length > 0) {
    context.flags.push({
      id: 'structured-data-divergence',
      severity: 'warn',
      basis: 'heuristic',
      message: divergent
        .map(
          (entry) =>
            `The structured data reported ${entry.kind} ${entry.left}; the visible page reported ${entry.right}.`,
        )
        .join(' '),
      evidence: evidenceLines,
    })
    return {
      earned: 0,
      evidence: evidenceLines,
      remedy:
        'Generate the structured data from the same source as the rendered page, so the two cannot drift.',
    }
  }

  return { earned: SUBPOINTS.textAgreement.full, evidence: evidenceLines }
}

// ---------------------------------------------------------------------------
// D6 — Contract & discovery
// ---------------------------------------------------------------------------

function canonicalOf(
  capture: ArsHttpCapture | null,
  representation: ArsRepresentation | null,
): string | null {
  if (capture !== null) {
    for (const link of parseLinkHeaders(headerAll(capture.headers, 'link'))) {
      if (link.rel.includes('canonical')) return link.url
    }
  }
  if (representation !== null && representation.doc !== null) {
    for (const link of representation.doc.links) {
      if (link.rel.includes('canonical') && link.href !== null) return link.href
    }
  }
  return null
}

function checkCanonical(context: ScoreContext): CheckOutcome {
  const split = SUBPOINTS.canonical
  const htmlCanonical =
    canonicalOf(context.browserCapture, context.browser) ??
    canonicalOf(context.agentCapture, context.agent)
  const agentCanonical = canonicalOf(context.agentCapture, context.agent)

  const present = htmlCanonical !== null
  const absolute = htmlCanonical !== null && /^https?:\/\//i.test(htmlCanonical)
  const consistent =
    htmlCanonical !== null && agentCanonical !== null && agentCanonical === htmlCanonical

  if (htmlCanonical !== null && agentCanonical !== null && agentCanonical !== htmlCanonical) {
    context.flags.push({
      id: 'canonical-mismatch',
      severity: 'warn',
      basis: 'measured',
      message: `The two representations of this URL declare different canonicals: ${agentCanonical} and ${htmlCanonical}.`,
      evidence: [
        measured('Agent probe canonical', agentCanonical),
        measured('HTML canonical', htmlCanonical),
      ],
    })
  }

  return {
    earned:
      (present ? split.present : 0) +
      (absolute ? split.absolute : 0) +
      (consistent ? split.consistentAcrossProbes : 0),
    evidence: [
      measured('Canonical (HTML)', htmlCanonical ?? 'absent'),
      measured('Canonical (agent representation)', agentCanonical ?? 'absent'),
      measured('Absolute', yesNo(absolute)),
      measured('Same across both probes', yesNo(consistent)),
    ],
    remedy: consistent
      ? undefined
      : agentCanonical === null
        ? 'Declare the canonical on the machine representation too — `Link: <https://…>; rel="canonical"`. A representation with no canonical cannot be attributed to a page.'
        : 'Declare one canonical URL and use it in both representations.',
  }
}

function checkCacheValidators(context: ScoreContext): CheckOutcome {
  const split = SUBPOINTS.cacheValidators
  const cacheControl = header(context.agentCapture.headers, 'cache-control')
  const directives = headerTokens(cacheControl)
  const noStore = directives.includes('no-store')
  const maxAge = directives.some((token) => {
    const match = /^(?:max-age|s-maxage)=(\d{1,10})$/.exec(token)
    return match !== null && Number(match[1]) > 0
  })
  const noCache = directives.includes('no-cache') || directives.includes('must-revalidate')
  const etag = header(context.agentCapture.headers, 'etag')
  const lastModified = header(context.agentCapture.headers, 'last-modified')
  const validator = etag !== null || lastModified !== null

  // "Sane" is: the response says how long it may be reused, or says to
  // revalidate — and revalidation only means anything with a validator.
  const sane = cacheControl !== null && !noStore && (maxAge || (noCache && validator))

  return {
    earned: (sane ? split.saneCacheControl : 0) + (validator ? split.validator : 0),
    evidence: [
      measured('Cache-Control', cacheControl ?? 'absent'),
      measured('ETag', etag ?? 'absent'),
      measured('Last-Modified', lastModified ?? 'absent'),
    ],
    remedy:
      sane && validator
        ? undefined
        : 'Send a `Cache-Control` a cache can act on, plus an `ETag` or `Last-Modified`. Repeat fetches are most of agent traffic.',
  }
}

function bodyOf(probe: ArsProbeRecord | null): string | null {
  if (probe === null || !probe.result.ok) return null
  const capture = probe.result.capture
  if (capture.status < 200 || capture.status >= 300) return null
  return typeof capture.body === 'string' ? capture.body : null
}

const MARKDOWN_LINK = /\[[^\]\n]{1,200}\]\(([^)\s]{1,500})\)/g

function checkLlmsTxt(context: ScoreContext): CheckOutcome {
  const split = SUBPOINTS.llmsTxt
  const body = bodyOf(context.evidence.probes.llmsTxt)
  if (body === null || body.trim().length === 0) {
    return {
      earned: 0,
      evidence: [measured('/llms.txt', body === null ? 'absent or non-2xx' : 'empty')],
      remedy:
        'Publish /llms.txt: an H1 title, a short summary, and links to the pages that matter. It is worth 1 point of 100, deliberately.',
    }
  }
  // The llms.txt convention: an H1 title, then Markdown links. Both halves are
  // checked because a file with a title and no links tells an agent nothing.
  const hasTitle = /^#\s+\S/m.test(body)
  MARKDOWN_LINK.lastIndex = 0
  const hasLinks = MARKDOWN_LINK.test(body)
  const specShaped = hasTitle && hasLinks

  return {
    earned: specShaped ? split.specShaped : split.present,
    evidence: [
      measured('/llms.txt', `${body.length} characters`),
      measured('H1 title', yesNo(hasTitle)),
      measured('Markdown links', yesNo(hasLinks)),
    ],
    remedy: specShaped ? undefined : 'Give /llms.txt an H1 title and at least one Markdown link.',
  }
}

function checkSitemap(context: ScoreContext): CheckOutcome {
  return {
    earned: context.policy.sitemapDeclared ? SUBPOINTS.sitemap.full : 0,
    evidence: [
      measured('Sitemap: in robots.txt', yesNo(context.policy.sitemapDeclared)),
      measured(
        'Sitemaps declared',
        context.robots === null ? 'n/a' : context.robots.sitemaps.join(', ') || 'none',
      ),
    ],
    remedy: context.policy.sitemapDeclared ? undefined : 'Declare `Sitemap:` in robots.txt.',
  }
}

/**
 * Media types and URL shapes that count as a declared machine endpoint (§3.4
 * D6.5: UCP/ACP/MCP/OpenAPI/GraphQL/RSS/Atom/ICS/JSON feed).
 *
 * Credit comes from DECLARATION. ARS probes `/robots.txt`, `/llms.txt` and
 * `/.well-known/ucp` and nothing else — no guessing at `/sitemap.xml`, `/mcp` or
 * `/acp` — because an endpoint an agent cannot find is an endpoint that does not
 * exist. The three probed paths are the disclosed exception: they are published
 * conventions with published locations.
 */
const ENDPOINT_TYPES: readonly string[] = [
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
  'application/ld+json',
  'application/vnd.api+json',
  'application/schema+json',
  'application/graphql',
  'application/openapi+json',
  'application/yaml',
  'text/calendar',
]
const ENDPOINT_RELS: readonly string[] = [
  'service-desc',
  'service-doc',
  'api',
  'describedby',
  'ucp',
  'mcp',
]
const ENDPOINT_PATH_MARKERS: readonly string[] = [
  '/api',
  '/mcp',
  '/graphql',
  '/openapi',
  '/.well-known/',
  '.json',
  '.ics',
  '.rss',
  '.atom',
]

function checkMachineEndpoint(context: ScoreContext): CheckOutcome {
  const declarations: string[] = []

  const links = parseLinkHeaders([
    ...headerAll(context.agentCapture.headers, 'link'),
    ...(context.browserCapture === null ? [] : headerAll(context.browserCapture.headers, 'link')),
  ])
  for (const link of links) {
    if (link.rel.some((rel) => ENDPOINT_RELS.includes(rel)))
      declarations.push(`Link rel=${link.rel.join(' ')} → ${link.url}`)
    else if (link.type !== null && ENDPOINT_TYPES.includes(link.type))
      declarations.push(`Link type=${link.type} → ${link.url}`)
  }

  if (context.structural !== null && context.structural.doc !== null) {
    for (const link of context.structural.doc.links) {
      if (link.href === null) continue
      if (link.rel.some((rel) => ENDPOINT_RELS.includes(rel)))
        declarations.push(`<link rel="${link.rel.join(' ')}"> → ${link.href}`)
      else if (link.type !== null && ENDPOINT_TYPES.includes(link.type))
        declarations.push(`<link type="${link.type}"> → ${link.href}`)
    }
  }

  const llms = bodyOf(context.evidence.probes.llmsTxt)
  if (llms !== null) {
    MARKDOWN_LINK.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MARKDOWN_LINK.exec(llms)) !== null) {
      const url = (match[1] ?? '').toLowerCase()
      if (ENDPOINT_PATH_MARKERS.some((marker) => url.includes(marker)))
        declarations.push(`llms.txt → ${match?.[1] ?? url}`)
    }
  }

  const ucp = bodyOf(context.evidence.probes.wellKnownUcp)
  if (ucp !== null && ucp.trim().length > 0) declarations.push('/.well-known/ucp')

  return {
    earned: declarations.length > 0 ? SUBPOINTS.machineEndpoint.full : 0,
    evidence: [
      measured(
        'Declared machine endpoints',
        declarations.length === 0 ? 'none' : declarations.join('; '),
      ),
      measured('Probed paths', '/robots.txt, /llms.txt, /.well-known/ucp — ARS probes no others'),
    ],
    remedy:
      declarations.length > 0
        ? undefined
        : 'Declare one machine endpoint — a feed, an OpenAPI document, /.well-known/ucp — with a `Link` header or a `<link>`. ARS does not guess at paths.',
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function weightOf(ruleset: ArsRuleset, id: ArsCheckId): number {
  return ruleset.weights[id] ?? 0
}

function buildCheck(ruleset: ArsRuleset, id: ArsCheckId, outcome: CheckOutcome): ArsCheck {
  const meta = CHECK_META[id]
  const weight = weightOf(ruleset, id)
  // Structural guarantee: `earned` is an integer in `[0, weight]`. Every branch
  // above already produces one; the clamp is what makes it impossible for a
  // future check to publish a number outside its own weight. Fixture 052 asserts
  // the property over the whole corpus.
  const earned = Math.max(0, Math.min(weight, outcome.earned))
  const check: ArsCheck = {
    id,
    label: meta.label,
    basis: meta.basis,
    weight,
    earned,
    evidence: outcome.evidence,
  }
  return outcome.remedy === undefined || earned === weight
    ? check
    : { ...check, remedy: outcome.remedy }
}

/**
 * Publication order. HAND-MAINTAINED AND THEREFORE DANGEROUS: a dimension
 * missing here is silently dropped from `dimensions`, and its checks' points
 * vanish from the total. ARS 0.2 shipped D7 without it for one commit and the
 * corpus re-scored against a maximum of 92. `score.test.ts` now asserts this
 * list covers `DIMENSION_META` exactly.
 */
const DIMENSION_ORDER: readonly ArsDimensionId[] = [
  'retrievability',
  'machine-representation',
  'fact-coverage',
  'fact-position',
  'structured-data',
  'contract-discovery',
  'evidence-density',
]

function buildDimensions(checks: readonly ArsCheck[]): ArsDimension[] {
  return DIMENSION_ORDER.map((id) => {
    const own = checks.filter((check) => CHECK_META[check.id].dimension === id)
    return {
      id,
      label: DIMENSION_META[id].label,
      weight: DIMENSION_META[id].weight,
      earned: own.reduce((sum, check) => sum + check.earned, 0),
      basis: own.some((check) => check.basis === 'heuristic')
        ? ('heuristic' as ArsBasis)
        : ('measured' as ArsBasis),
      checks: own,
    }
  })
}

/** Pinned flag order, so two runs over the same evidence emit the same array. */
const FLAG_ORDER: readonly ArsFlagId[] = [
  'substance-divergence',
  'structured-data-divergence',
  'robots-contradiction',
  'paywalled',
  'render-dependent',
  'scanner-blocked',
  'training-opt-out',
  'assistant-opt-out',
  'vary-missing',
  'canonical-mismatch',
  'body-truncated',
  'vantage-variance',
]

function sortFlags(flags: readonly ArsFlag[]): ArsFlag[] {
  return [...flags].sort((a, b) => FLAG_ORDER.indexOf(a.id) - FLAG_ORDER.indexOf(b.id))
}

/** The band a score falls in. Bands headline; the integer is secondary (§3.6). */
export function bandFor(score: number, ruleset: ArsRuleset = DEFAULT_RULESET): ArsBand | null {
  for (const band of ruleset.bands) if (score >= band.min && score <= band.max) return band
  return null
}

// ---------------------------------------------------------------------------
// Evidence plumbing
// ---------------------------------------------------------------------------

function captureOf(probe: ArsProbeRecord | null): ArsHttpCapture | null {
  return probe !== null && probe.result.ok ? probe.result.capture : null
}

/**
 * The currency the page prices in, read from structured data and Open Graph.
 * The SAME hint is used for both representations, deliberately: a hint is a
 * property of the page, and letting the two representations resolve `$` to
 * different currencies would manufacture a substance divergence out of nothing.
 */
function currencyHintOf(
  structural: ArsRepresentation | null,
  agent: ArsRepresentation,
): string | undefined {
  for (const representation of [structural, agent]) {
    if (representation === null) continue
    for (const node of representation.jsonLd.nodes) {
      for (const path of ['offers.priceCurrency', 'priceCurrency']) {
        const raw = readPath(node, path)
        if (raw !== null && /^[A-Za-z]{3}$/.test(raw.trim())) return raw.trim().toUpperCase()
      }
    }
    if (representation.doc === null) continue
    for (const meta of representation.doc.metas) {
      const key = meta.property ?? meta.name
      if (key !== 'og:price:currency' && key !== 'product:price:currency') continue
      const value = meta.content
      if (value !== null && /^[A-Za-z]{3}$/.test(value.trim())) return value.trim().toUpperCase()
    }
  }
  return undefined
}

function pathOf(url: string, fallback: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return fallback
  }
}

/** robots.txt status and parse, from the probe record alone. */
function readRobots(probe: ArsProbeRecord | null): {
  status: ArsPolicyReport['robotsTxtStatus']
  robots: RobotsFile | null
} {
  if (probe === null) return { status: 'missing', robots: null }
  if (!probe.result.ok) return { status: 'error', robots: null }
  const capture = probe.result.capture
  if (capture.status >= 500) return { status: 'error', robots: null }
  if (capture.status >= 400) return { status: 'missing', robots: null }
  const body = typeof capture.body === 'string' ? capture.body : null
  if (body === null) return { status: 'missing', robots: null }
  const robots = parseRobots(body)
  const empty = robots.groups.length === 0 && robots.sitemaps.length === 0
  return { status: empty && robots.malformedLines > 0 ? 'unparseable' : 'ok', robots }
}

/** Declared paywalls only (§3.8). Undeclared soft paywalls need impersonation, which we refuse. */
function detectPaywall(context: {
  structural: ArsRepresentation | null
  agentCapture: ArsHttpCapture
}): string | null {
  if (context.agentCapture.status === 402) return 'HTTP 402'
  if (header(context.agentCapture.headers, 'www-authenticate') !== null) return 'WWW-Authenticate'
  for (const node of context.structural?.jsonLd.nodes ?? []) {
    const value = node.value['isAccessibleForFree']
    if (value === false || value === 'False' || value === 'false')
      return 'isAccessibleForFree: false'
  }
  return null
}

// ---------------------------------------------------------------------------
// Non-grades
// ---------------------------------------------------------------------------

/**
 * The result shape for the three non-grades (§3.6). `score` is null and there is
 * no letter — an opt-out is a choice and an unscored target is a missing
 * observation, and neither is an F.
 *
 * The six dimensions are still present with their weights, because §3.9 says
 * `dimensions` always has 6 entries summing to 100, but every check reports
 * `earned: 0` with an evidence line naming the reason. A non-grade is a
 * statement that we did not score; publishing sub-scores next to it would be
 * scoring by another name.
 */
function nonGrade(
  evidence: ArsEvidence,
  ruleset: ArsRuleset,
  outcome: ArsOutcome,
  reason: string,
  policy: ArsPolicyReport,
  flags: readonly ArsFlag[],
): ArsResult {
  const agentCapture = captureOf(evidence.probes.agent)
  const browserCapture = captureOf(evidence.probes.browser)
  const checks = (Object.keys(CHECK_META) as ArsCheckId[]).map((id) =>
    buildCheck(ruleset, id, {
      earned: 0,
      evidence: [{ label: 'Not evaluated', value: reason, basis: CHECK_META[id].basis }],
    }),
  )
  const htmlBytes = browserCapture?.bytes ?? agentCapture?.bytes ?? 0
  const perToken = ruleset.thresholds['cost.approx-bytes-per-token']?.[0] ?? 4

  return {
    spec: 'ars',
    specVersion: ARS_SPEC_VERSION,
    rulesetHash: rulesetHash(ruleset),
    corpusHash: ARS_CORPUS_HASH,
    evidenceHash: evidenceHash(evidence),
    vantage: evidence.vantage,
    target: {
      url: evidence.target.url,
      finalUrl: agentCapture?.finalUrl ?? evidence.target.url,
      origin: evidence.target.origin,
    },
    outcome,
    score: null,
    grade: null,
    bandLabel: null,
    pageKind: 'unknown',
    pageKindBasis: 'heuristic',
    pageKindConfidence: 'low',
    factProfile: profileFor('unknown'),
    facts: [],
    dimensions: buildDimensions(checks),
    flags: sortFlags(flags),
    policy,
    cost: {
      htmlBytes,
      negotiatedBytes: null,
      approxHtmlTokens: idiv(htmlBytes, perToken),
      approxNegotiatedTokens: null,
      reductionRatio: null,
      firstCoreFactOffset: null,
      truncated: (agentCapture?.truncated ?? false) || (browserCapture?.truncated ?? false),
    },
    recommendations: [],
    measuredWeight: measuredWeightOf(ruleset),
    heuristicWeight: heuristicWeightOf(ruleset),
  }
}

function measuredWeightOf(ruleset: ArsRuleset): number {
  let total = 0
  for (const id of Object.keys(CHECK_META) as ArsCheckId[]) {
    if (CHECK_META[id].basis === 'measured') total += weightOf(ruleset, id)
  }
  return total
}

function heuristicWeightOf(ruleset: ArsRuleset): number {
  let total = 0
  for (const id of Object.keys(CHECK_META) as ArsCheckId[]) {
    if (CHECK_META[id].basis === 'heuristic') total += weightOf(ruleset, id)
  }
  return total
}

/** Probe error → the reason ARS publishes. `detail` carries the probe's own word for it. */
function unscoredReasonFor(error: string): { reason: ArsUnscoredReason; detail?: string } {
  switch (error) {
    case 'challenge':
      return { reason: 'blocked-at-edge', detail: 'challenge' }
    case 'non-2xx':
      return { reason: 'non-2xx' }
    case 'too-many-redirects':
      return { reason: 'too-many-redirects' }
    case 'timeout':
      return { reason: 'unreachable', detail: 'timeout' }
    case 'blocked-redirect':
      return { reason: 'unreachable', detail: 'blocked-redirect' }
    case 'policy-rejected':
      return { reason: 'unreachable', detail: 'policy-rejected' }
    default:
      return { reason: 'unreachable' }
  }
}

// ---------------------------------------------------------------------------
// score()
// ---------------------------------------------------------------------------

/**
 * The entire pure surface. No network. No clock. No randomness. No LLM.
 *
 * GATE ORDER, and why it is this order:
 *  1. `robots-disallow-scanner` — a statement about OUR conduct. If we were not
 *     allowed to fetch, nothing else about the evidence should be reported.
 *     Only `vantage: 'public'` is gated; an owner can consent for their own
 *     origin (§3.7), and a merchant scanning their own store getting `unscored`
 *     because they block unknown tokens is a product regression dressed as rigour.
 *  2. `robots-unavailable` — a persistent 5xx means we could not learn the policy.
 *  3. `opt-out` — the site's own decision, reported before any failure of ours,
 *     because it is a choice and not a failure.
 *  4. Fetch failures, then a bundle with no body, then a truncated body.
 */
export function score(evidence: ArsEvidence, ruleset: ArsRuleset = DEFAULT_RULESET): ArsResult {
  const flags: ArsFlag[] = []
  const targetPath = pathOf(evidence.target.url, '/')
  const { status: robotsStatus, robots } = readRobots(evidence.probes.robotsTxt)
  const policy = buildPolicyReport(robots, robotsStatus, ruleset, targetPath)

  if (policy.trainingOptOut) {
    flags.push({
      id: 'training-opt-out',
      severity: 'info',
      basis: 'measured',
      message:
        'This site blocks model-training crawlers while allowing assistant fetches. That is neutral in ARS: it never lowers the score.',
      evidence: [
        measured('Training audience', policy.audiences.training.matchedRule ?? 'disallowed'),
        measured('Effect on this score', 'none'),
      ],
    })
  }

  // 1 — we obey our own token, and say so.
  if (evidence.vantage === 'public' && robots !== null) {
    const scannerDecision = decideScannerToken(robots, targetPath)
    if (scannerDecision) {
      flags.push({
        id: 'scanner-blocked',
        severity: 'info',
        basis: 'measured',
        message:
          'robots.txt disallows the rebilder-ars scanner. We obeyed it and did not score this page.',
        evidence: [measured('Matched rule', scannerDecision)],
      })
      return nonGrade(
        evidence,
        ruleset,
        { kind: 'unscored', reason: 'robots-disallow-scanner' },
        'robots.txt disallows the rebilder-ars token',
        policy,
        flags,
      )
    }
  }

  // 2 — a policy we could not read is not a policy we may assume.
  if (robotsStatus === 'error') {
    return nonGrade(
      evidence,
      ruleset,
      { kind: 'unscored', reason: 'robots-unavailable' },
      'robots.txt returned a persistent error',
      policy,
      flags,
    )
  }

  // 3 — a deliberate, well-formed opt-out. Not a failure, not ranked, no letter.
  if (policy.deliberateOptOut) {
    flags.push({
      id: 'assistant-opt-out',
      severity: 'info',
      basis: 'measured',
      message:
        'This site names assistant crawlers in robots.txt and disallows them. ARS records the choice and does not grade the page.',
      evidence: [
        measured('Matched group', policy.audiences.assistant.matchedGroup ?? '(named group)'),
        measured('Matched rule', policy.audiences.assistant.matchedRule ?? 'Disallow'),
      ],
    })
    return nonGrade(
      evidence,
      ruleset,
      { kind: 'opt-out', audience: 'assistant' satisfies ArsAudience, wellFormed: true },
      'the site opted out of assistant crawling',
      policy,
      flags,
    )
  }

  // 4 — fetch failures.
  const agentProbe = evidence.probes.agent
  if (!agentProbe.result.ok) {
    const { reason, detail } = unscoredReasonFor(agentProbe.result.error)
    if (reason === 'blocked-at-edge') {
      flags.push({
        id: 'scanner-blocked',
        severity: 'warn',
        basis: 'measured',
        message:
          'The origin answered the agent probe with a challenge or a block. ARS reports the evidence and does not grade the page.',
        evidence: [measured('Probe error', agentProbe.result.error)],
      })
    }
    const outcome: ArsOutcome =
      detail === undefined ? { kind: 'unscored', reason } : { kind: 'unscored', reason, detail }
    return nonGrade(
      evidence,
      ruleset,
      outcome,
      `the agent probe failed: ${agentProbe.result.error}`,
      policy,
      flags,
    )
  }

  const agentCapture = agentProbe.result.capture
  if (agentCapture.status === 403 || agentCapture.status === 401 || agentCapture.status === 429) {
    flags.push({
      id: 'scanner-blocked',
      severity: 'warn',
      basis: 'measured',
      message: `The origin answered the agent probe with HTTP ${agentCapture.status}. ARS reports the evidence and does not grade the page.`,
      evidence: [measured('HTTP status', String(agentCapture.status))],
    })
    return nonGrade(
      evidence,
      ruleset,
      { kind: 'unscored', reason: 'blocked-at-edge', detail: `HTTP ${agentCapture.status}` },
      `the origin answered with HTTP ${agentCapture.status}`,
      policy,
      flags,
    )
  }
  if (agentCapture.status < 200 || agentCapture.status >= 300) {
    return nonGrade(
      evidence,
      ruleset,
      { kind: 'unscored', reason: 'non-2xx', detail: `HTTP ${agentCapture.status}` },
      `the origin answered with HTTP ${agentCapture.status}`,
      policy,
      flags,
    )
  }
  if (agentCapture.redirects.length > ruleset.maxRedirects) {
    return nonGrade(
      evidence,
      ruleset,
      {
        kind: 'unscored',
        reason: 'too-many-redirects',
        detail: `${agentCapture.redirects.length} hops`,
      },
      `the agent path took ${agentCapture.redirects.length} redirect hops`,
      policy,
      flags,
    )
  }

  const browserCapture = captureOf(evidence.probes.browser)
  if (agentCapture.truncated || (browserCapture?.truncated ?? false)) {
    flags.push({
      id: 'body-truncated',
      severity: 'warn',
      basis: 'measured',
      message: `A response exceeded the ${ruleset.maxBodyBytes}-byte body cap and was truncated. The fact set and the byte count would both be wrong, so the page is not scored.`,
      evidence: [
        measured('Body cap', `${ruleset.maxBodyBytes} bytes`),
        measured('Bytes read', `≥ ${agentCapture.bytes}`),
      ],
    })
    return nonGrade(
      evidence,
      ruleset,
      { kind: 'unscored', reason: 'truncated-evidence' },
      'the response exceeded the body cap and was truncated',
      policy,
      flags,
    )
  }

  const agent = buildRepresentation(agentCapture)
  if (agent === null) {
    return nonGrade(
      evidence,
      ruleset,
      {
        kind: 'unscored',
        reason: 'evidence-incomplete',
        detail: 'the bundle carries no response body',
      },
      'the evidence bundle carries hashes but no body, so it cannot be re-scored',
      policy,
      flags,
    )
  }
  const browser = browserCapture === null ? null : buildRepresentation(browserCapture)
  const structural =
    browser !== null && browser.doc !== null ? browser : agent.doc !== null ? agent : browser

  // ── classification (pass 1) ──────────────────────────────────────────────
  const classification = classify(pass1Signals(structural ?? agent, evidence.target.url))
  const profile = profileFor(classification.pageKind)

  // ── extraction (pass 2) ──────────────────────────────────────────────────
  const currencyHint = currencyHintOf(structural, agent)
  const extractContext = {
    profile,
    ruleset,
    baseUrl: agentCapture.finalUrl,
    origin: evidence.target.origin,
    currencyHint,
  }
  const agentFacts = extractFacts(agent, extractContext)
  const browserFacts =
    browser === null || browser === agent
      ? []
      : extractFacts(browser, { ...extractContext, baseUrl: browser.finalUrl })
  const structuralFacts =
    structural === agent ? agentFacts : structural === browser ? browserFacts : []
  const facts = mergeFacts(agentFacts, structuralFacts)

  const context: ScoreContext = {
    evidence,
    ruleset,
    agentCapture,
    browserCapture,
    agent,
    browser,
    structural,
    classification,
    profile,
    facts,
    agentFacts,
    browserFacts,
    structuralFacts,
    policy,
    robots,
    flags,
  }

  const paywall = detectPaywall(context)
  if (paywall !== null) {
    flags.push({
      id: 'paywalled',
      severity: 'info',
      basis: 'measured',
      message: `This page declares a paywall (${paywall}). ARS scores the portion it was served and does not attempt to reach the gated part.`,
      evidence: [measured('Paywall signal', paywall)],
    })
  }

  // ── the 22 checks ────────────────────────────────────────────────────────
  const math = coverageMath(context)
  const offsets = coreOffsets(context)
  const negotiated = checkNegotiatedResponse(context)

  const checks: ArsCheck[] = [
    buildCheck(ruleset, 'retrievability.reachable', checkReachable(context)),
    buildCheck(ruleset, 'retrievability.robots-policy', checkRobotsPolicy(context)),
    buildCheck(ruleset, 'retrievability.render-independence', checkRenderIndependence(context)),
    buildCheck(ruleset, 'machine-representation.negotiated-response', negotiated),
    buildCheck(
      ruleset,
      'machine-representation.declared-alternates',
      checkDeclaredAlternates(context),
    ),
    buildCheck(
      ruleset,
      'machine-representation.vary-accept',
      checkVaryAccept(context, negotiated.earned),
    ),
    buildCheck(
      ruleset,
      'machine-representation.substance-parity',
      checkSubstanceParity(context, negotiated.earned),
    ),
    buildCheck(ruleset, 'fact-coverage.core-facts', checkCoreFacts(context, math)),
    buildCheck(ruleset, 'fact-coverage.context-cost', checkContextCost(context)),
    buildCheck(
      ruleset,
      'fact-position.first-core-fact-offset',
      checkFirstCoreFactOffset(context, offsets),
    ),
    buildCheck(ruleset, 'fact-position.front-window', checkFrontWindow(context, offsets)),
    buildCheck(ruleset, 'structured-data.present', checkStructuredDataPresent(context)),
    buildCheck(ruleset, 'structured-data.required-properties', checkRequiredProperties(context)),
    buildCheck(ruleset, 'structured-data.text-agreement', checkTextAgreement(context)),
    buildCheck(ruleset, 'contract-discovery.canonical', checkCanonical(context)),
    buildCheck(ruleset, 'contract-discovery.cache-validators', checkCacheValidators(context)),
    buildCheck(ruleset, 'contract-discovery.llms-txt', checkLlmsTxt(context)),
    buildCheck(ruleset, 'contract-discovery.sitemap', checkSitemap(context)),
    buildCheck(ruleset, 'contract-discovery.machine-endpoint', checkMachineEndpoint(context)),
    buildCheck(ruleset, 'evidence-density.quantities', checkQuantities(context)),
    buildCheck(ruleset, 'evidence-density.definitions', checkDefinitions(context)),
    buildCheck(ruleset, 'evidence-density.comparisons', checkComparisons(context)),
  ]

  const dimensions = buildDimensions(checks)
  const total = dimensions.reduce((sum, dimension) => sum + dimension.earned, 0)
  const band = bandFor(total, ruleset)
  const grade: ArsGrade = band?.grade ?? 'F'

  const perToken = ruleset.thresholds['cost.approx-bytes-per-token']?.[0] ?? 4
  const htmlBytes = structural?.bytes ?? agent.bytes
  const negotiatedBytes = negotiated.earned > 0 ? agent.bytes : null
  const cost: ArsCostReport = {
    htmlBytes,
    negotiatedBytes,
    approxHtmlTokens: idiv(htmlBytes, perToken),
    approxNegotiatedTokens: negotiatedBytes === null ? null : idiv(negotiatedBytes, perToken),
    // Integer PERCENT of HTML bytes the machine representation eliminates:
    // 94 means "94% fewer bytes". §3.9 types this as a number and does not fix
    // its unit; a multiple (`4.2×`) would be a float, and this is the same
    // information with no rounding for two implementations to disagree about.
    reductionRatio:
      negotiatedBytes === null || htmlBytes === 0
        ? null
        : Math.max(0, 100 - idiv(100 * negotiatedBytes, htmlBytes)),
    firstCoreFactOffset: offsets[0] ?? null,
    truncated: agent.truncated || (browser?.truncated ?? false),
  }

  const published: ArsFactObservation[] = facts.map((fact) => ({
    kind: fact.kind,
    normalized: fact.normalized,
    source: fact.source,
    offset: fact.offset,
    corroborated: fact.corroborated,
  }))

  return {
    spec: 'ars',
    specVersion: ARS_SPEC_VERSION,
    rulesetHash: rulesetHash(ruleset),
    corpusHash: ARS_CORPUS_HASH,
    evidenceHash: evidenceHash(evidence),
    vantage: evidence.vantage,
    target: {
      url: evidence.target.url,
      finalUrl: agentCapture.finalUrl,
      origin: evidence.target.origin,
    },
    outcome: { kind: 'scored', grade, score: total },
    score: total,
    grade,
    bandLabel: band?.label ?? null,
    pageKind: classification.pageKind,
    pageKindBasis: 'heuristic',
    pageKindConfidence: classification.confidence,
    factProfile: profile,
    facts: published,
    dimensions,
    flags: sortFlags(flags),
    policy,
    cost,
    recommendations: recommend({ dimensions, score: total }),
    measuredWeight: measuredWeightOf(ruleset),
    heuristicWeight: heuristicWeightOf(ruleset),
  }
}

/**
 * The product token the probe sends (§3.3). This is the ONLY place in the scorer
 * where our own identity is an input to a decision, and the decision it drives is
 * to score nothing.
 */
const SCANNER_TOKEN = 'rebilder-ars'

/**
 * Does robots.txt disallow the ARS scanner itself? Returns the matched rule when
 * it does, so the result can print the line rather than assert a verdict.
 *
 * Only a group that NAMES `rebilder-ars` counts. A blanket `User-agent: *`
 * disallow is not a decision about us: it is the accidental case (§3.7), which is
 * scored with `robots-contradiction`, not silently exempted. Rule selection is
 * RFC 9309 longest-match with ties to Allow, via `./extract`'s `pathMatches` —
 * the same matcher `decideRobots` uses, so the scanner gate and the audience
 * decision can never disagree about what a pattern means.
 */
function decideScannerToken(robots: RobotsFile, path: string): string | null {
  for (const group of robots.groups) {
    if (!group.agents.some((agent) => agent === SCANNER_TOKEN)) continue
    let best: { field: 'allow' | 'disallow'; value: string } | null = null
    for (const value of group.allow) {
      if (!pathMatches(value, path)) continue
      if (best === null || value.length > best.value.length) best = { field: 'allow', value }
    }
    for (const value of group.disallow) {
      if (!pathMatches(value, path)) continue
      if (best === null || value.length > best.value.length) best = { field: 'disallow', value }
    }
    if (best !== null && best.field === 'disallow') {
      return `User-agent: ${SCANNER_TOKEN} / Disallow: ${best.value}`
    }
  }
  return null
}
