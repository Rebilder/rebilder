/**
 * score.ts — the ARS 0.3 scoring engine. The whole pure half comes together here.
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
 * makes the published ceiling provable: no content negotiation loses D2.1 (9) +
 * D2.3 (3) + D2.4 (3) → max 85 → capped at B. The forbidden direction — a
 * heuristic that can zero measured points — appears nowhere. In particular D2.4
 * and D5.3 are SCORED CHECKS, NOT GATES: a parity failure loses its own 3 points
 * and raises a `warn`, and leaves D2's other 15 measured points alone. That is
 * the whole reason "measured 63 / heuristic 37" is an honest split rather than a
 * presentational one.
 *
 * EVIDENCE IS WRITTEN FOR THE SITE OWNER. Labels, values, remedies and flag
 * messages are printed on the public scan page, so they use plain words and name
 * a header or file only where a developer needs it to act. "Content
 * negotiation" in particular is written as what it means to a merchant: the
 * page sends AI assistants a Markdown copy when they ask for one. None of this
 * text is in the conformance projection, so rewording it is a PATCH.
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
  /**
   * D2.1, 9 for a machine copy served at the page's own address on `Accept`
   * negotiation: a machine media type AND a body that is not HTML. ARS 0.3: 6
   * when the page does not negotiate but the Markdown copy it declares as an
   * alternate was fetched and is real. Less than full because only agents that
   * look for the link reach it, and they pay a second request to do so.
   */
  negotiatedResponse: { full: 9, linkedCopy: 6 },
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
        // ARS 0.3, and only when present, so a 0.2 bundle hashes as it did.
        ...(evidence.probes.markdownAlternate === undefined
          ? {}
          : { markdownAlternate: redactProbe(evidence.probes.markdownAlternate) }),
      },
    }),
  )
}

/**
 * Version marker for the ARS 0.3 corpus (spec §2.4.3).
 * This is the hash of the versioned marker string, not of fixture contents.
 * A corpus-content digest replaces it at corpus freeze in a MINOR release.
 */
export const ARS_CORPUS_HASH = sha256Hex('ars-0.3-corpus-unfrozen')

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
/** The Markdown copy a page links to, as the probe found it (ARS 0.3). */
interface LinkedCopy {
  /** The declared URL the probe should have fetched. */
  readonly url: string
  /** `checked`: fetched and real. `broken`: fetched and not Markdown. `unchecked`: not in the bundle. */
  readonly status: 'checked' | 'broken' | 'unchecked'
  readonly representation: ArsRepresentation | null
  /** Why a broken copy failed, in plain words. */
  readonly reason: string | null
}

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
  /** True when the agent probe itself received a machine copy (negotiation). */
  readonly negotiated: boolean
  /** The declared Markdown copy, when the page links to one and does not negotiate. */
  readonly linkedCopy: LinkedCopy | null
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

/**
 * Plain names for fact kinds, for evidence and remedies a site owner reads. The
 * kind ids stay the published vocabulary; this is only how they are printed.
 */
const FACT_NAMES: Readonly<Record<ArsFactKind, string>> = {
  title: 'name or title',
  description: 'description',
  updated: 'last-updated date',
  published: 'publish date',
  price: 'price',
  currency: 'currency',
  availability: 'availability',
  brand: 'brand',
  sku: 'SKU',
  shipping: 'shipping details',
  returns: 'returns policy',
  'org-name': 'business name',
  address: 'address',
  hours: 'opening hours',
  phone: 'phone number',
  email: 'email address',
  'service-area': 'service area',
  author: 'author',
  section: 'section',
  authority: 'publisher',
  'primary-action-url': 'main action link (such as Buy, Book, Contact or Install)',
  eligibility: 'eligibility',
  duration: 'duration',
  'question-answer': 'questions and answers',
  'item-count': 'number of items',
  'item-link': 'links to the items',
}

function factName(kind: ArsFactKind): string {
  return FACT_NAMES[kind] ?? kind
}

function factList(kinds: readonly ArsFactKind[]): string {
  return kinds.map(factName).join(', ')
}

/**
 * Bytes as a reader says them. Integer arithmetic only, so the string is the
 * same in every implementation: under 1 KB prints bytes, above it prints whole
 * kilobytes (1 KB = 1024 bytes), rounded half-up.
 */
function plainBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  return `${divRoundHalfUp(bytes, 1024)} KB`
}

/** Plain words for a robots.txt status. */
const ROBOTS_STATUS: Readonly<Record<ArsPolicyReport['robotsTxtStatus'], string>> = {
  ok: 'found',
  missing: 'not found (nothing is blocked)',
  error: 'the server returned an error',
  unparseable: 'found, but it could not be read',
}

/** The gated D2 checks' evidence while no Markdown copy is served. */
const COUNTS_ONCE_COPY = 'only once the page sends AI assistants a Markdown copy, so 0 for now'

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
    measured('Status code AI assistants got', String(agentCapture.status)),
    measured('Redirects on the way', `${hops} (up to ${ruleset.maxRedirects} allowed)`),
    measured(
      'Same address for AI assistants and browsers',
      browserCapture === null
        ? 'not checked, because this scan has no browser request to compare'
        : yesNo(sameFinalUrl),
    ),
  ]
  return sameFinalUrl
    ? { earned, evidence }
    : {
        earned,
        evidence,
        remedy:
          'Send AI assistants and browsers to the same address. A redirect that depends on the Accept header sends assistants to a page browsers never see.',
      }
}

function checkRobotsPolicy(context: ScoreContext): CheckOutcome {
  const { policy, robots } = context
  const split = SUBPOINTS.robotsPolicy
  const decision = policy.audiences.assistant
  const parsesClean = robots === null || robots.malformedLines === 0
  const noOrphanRules = robots === null || robots.orphanRules === 0

  const rule =
    decision.matchedGroup === null
      ? ''
      : ` (User-agent: ${decision.matchedGroup}${
          decision.matchedRule === null ? '' : `, ${decision.matchedRule}`
        })`
  const evidence = [
    measured('robots.txt', ROBOTS_STATUS[policy.robotsTxtStatus]),
    measured(
      'AI assistants allowed',
      decision.decision === 'disallow'
        ? `no${rule}`
        : decision.matchedGroup === null
          ? 'yes, no rule mentions them'
          : `yes${rule}`,
    ),
    measured('Lines that could not be read', robots === null ? 'none' : String(robots.malformedLines)),
    measured(
      'Rules outside a User-agent group',
      robots === null ? 'none' : String(robots.orphanRules),
    ),
    measured('Sitemap listed', yesNo(policy.sitemapDeclared)),
    measured(
      'AI training crawlers',
      policy.trainingOptOut ? 'blocked, which does not affect this score' : 'allowed',
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
        'Your robots.txt blocks AI assistants with a rule written for all crawlers. That looks accidental, and it keeps assistants out.',
      evidence: [evidence[1] ?? measured('AI assistants allowed', 'no')],
    })
    return {
      earned: 0,
      evidence,
      remedy:
        'Your robots.txt blocks AI assistants with a rule meant for all crawlers. If you want assistants to read your pages, give them their own group that allows them, such as ChatGPT-User and Claude-User.',
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
      : 'Add a `Sitemap:` line to robots.txt so assistants can find the rest of your pages.',
  }
}

function checkRenderIndependence(context: ScoreContext): CheckOutcome {
  const { structural, structuralFacts, profile } = context
  const split = SUBPOINTS.renderIndependence
  const coreSize = profile.core.length

  if (structural === null || structural.doc === null) {
    return {
      earned: 0,
      evidence: [heuristic('HTML page', 'not checked, because no HTML was returned')],
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
      message: `${found.size} of ${coreSize} key facts for this kind of page were in the HTML before any JavaScript ran. An assistant that does not run scripts sees the rest as missing.`,
      evidence: [heuristic('Key facts in the HTML', `${found.size} of ${coreSize}`)],
    })
  }

  return {
    earned,
    evidence: [
      heuristic('Key facts in the HTML before JavaScript runs', `${found.size} of ${coreSize}`),
      heuristic('Fallback text for visitors without JavaScript', yesNo(hasNoscript)),
      heuristic(
        'How we checked',
        'we read the HTML your server sends and do not run JavaScript, so facts added by scripts count as missing',
      ),
    ],
    remedy:
      earned === full
        ? undefined
        : 'Put the key facts in the HTML your server sends. Most AI assistants do not run JavaScript, so facts added by scripts are invisible to them.',
  }
}

// ---------------------------------------------------------------------------
// D2 — Machine representation
// ---------------------------------------------------------------------------

/** Media types that count as a machine representation for D2.1 (§3.4). */
const MACHINE_KINDS: ReadonlySet<ArsRepresentation['kind']> = new Set(['markdown', 'text', 'json'])

/** Whether a capture is a machine copy: a machine media type and a body that is not HTML. */
export function isMachineCopy(capture: ArsHttpCapture): boolean {
  const representation = buildRepresentation(capture)
  return (
    representation !== null &&
    MACHINE_KINDS.has(representation.kind) &&
    !representation.looksLikeHtml
  )
}

const MARKDOWN_MEDIA: ReadonlySet<string> = new Set(['text/markdown', 'text/x-markdown'])

function isMarkdownType(type: string | null): boolean {
  return type !== null && MARKDOWN_MEDIA.has((type.split(';')[0] ?? '').trim().toLowerCase())
}

/**
 * The Markdown copies a page declares as alternates, as absolute URLs without a
 * fragment, deduplicated, in a fixed order: `Link` headers on each capture, then
 * `<link rel="alternate" type="text/markdown">` in each capture's HTML.
 */
export function declaredMarkdownAlternates(captures: readonly (ArsHttpCapture | null)[]): string[] {
  const out: string[] = []
  const add = (raw: string, base: string): void => {
    try {
      const url = new URL(raw, base)
      url.hash = ''
      const href = url.toString()
      if (!out.includes(href)) out.push(href)
    } catch {
      // An unparseable href declares nothing.
    }
  }
  for (const capture of captures) {
    if (capture === null) continue
    for (const link of parseLinkHeaders(headerAll(capture.headers, 'link'))) {
      if (link.rel.includes('alternate') && isMarkdownType(link.type)) add(link.url, capture.finalUrl)
    }
  }
  for (const capture of captures) {
    if (capture === null) continue
    const representation = buildRepresentation(capture)
    if (representation === null || representation.doc === null) continue
    for (const link of representation.doc.links) {
      if (!link.rel.includes('alternate') || link.href === null) continue
      if (isMarkdownType(link.type)) add(link.href, capture.finalUrl)
    }
  }
  return out
}

/**
 * THE ONE MARKDOWN ALTERNATE ARS FETCHES (§3.3, ARS 0.3), shared by the probe and
 * the scorer so the two cannot disagree about which URL was meant. The first
 * declared Markdown copy that is on the target's origin and is not the page's
 * own address; null when the agent probe already received a machine copy, when
 * it did not get a 2xx, or when nothing qualifies. One extra request at most.
 */
export function markdownAlternateTarget(
  agent: ArsHttpCapture | null,
  browser: ArsHttpCapture | null,
  origin: string,
): string | null {
  if (agent === null || agent.status < 200 || agent.status >= 300) return null
  if (isMachineCopy(agent)) return null
  const own = new Set([agent.finalUrl, agent.requestedUrl])
  for (const href of declaredMarkdownAlternates([browser, agent])) {
    let sameOrigin = false
    try {
      sameOrigin = new URL(href).origin === origin
    } catch {
      sameOrigin = false
    }
    if (sameOrigin && !own.has(href)) return href
  }
  return null
}

/** What the bundle says about the linked Markdown copy, checked against the declaration. */
function linkedCopyOf(
  evidence: ArsEvidence,
  agent: ArsHttpCapture,
  browser: ArsHttpCapture | null,
): LinkedCopy | null {
  const url = markdownAlternateTarget(agent, browser, evidence.target.origin)
  if (url === null) return null
  const record = evidence.probes.markdownAlternate ?? null
  if (record === null) return { url, status: 'unchecked', representation: null, reason: null }
  if (!record.result.ok) {
    // A refusal is not an observation. robots.txt telling rebilder-ars to stay
    // off the file, or our own safety policy, means we never saw it, and a
    // measured check never deducts for what we did not see.
    if (record.result.error === 'policy-rejected') {
      return { url, status: 'unchecked', representation: null, reason: null }
    }
    return { url, status: 'broken', representation: null, reason: record.result.error }
  }
  const capture = record.result.capture
  // A record for some other URL is not evidence about this declaration.
  if (capture.requestedUrl !== url) {
    return { url, status: 'unchecked', representation: null, reason: null }
  }
  if (capture.status < 200 || capture.status >= 300) {
    return { url, status: 'broken', representation: null, reason: `HTTP ${capture.status}` }
  }
  if (!isMachineCopy(capture)) {
    return { url, status: 'broken', representation: null, reason: 'it returned HTML, not Markdown' }
  }
  return { url, status: 'checked', representation: buildRepresentation(capture), reason: null }
}

/** Plain names for the media types the probe asks for, in the order it asks. */
const MEDIA_NAMES: Readonly<Record<string, string>> = {
  'text/markdown': 'Markdown',
  'text/x-markdown': 'Markdown',
  'text/html': 'HTML',
  'text/plain': 'plain text',
  'application/json': 'JSON',
  '*/*': 'anything else',
}

/** `text/markdown;q=1.0, text/html;q=0.8` → `Markdown first, then HTML`. */
function acceptSummary(accept: string): string {
  const names: string[] = []
  for (const entry of accept.split(',')) {
    const type = (entry.split(';')[0] ?? '').trim().toLowerCase()
    if (type === '') continue
    const name = MEDIA_NAMES[type] ?? type
    if (!names.includes(name)) names.push(name)
  }
  const [first, ...rest] = names
  if (first === undefined) return accept
  return rest.length === 0 ? first : `${first} first, then ${rest.join(', ')}`
}

function checkNegotiatedResponse(context: ScoreContext): CheckOutcome {
  const { agent, linkedCopy } = context
  const typeIsMachine = MACHINE_KINDS.has(agent.kind)
  const bodyIsHtml = agent.looksLikeHtml
  const linkedWorks = linkedCopy !== null && linkedCopy.status === 'checked'
  const earned = context.negotiated
    ? SUBPOINTS.negotiatedResponse.full
    : linkedWorks
      ? SUBPOINTS.negotiatedResponse.linkedCopy
      : 0

  const asked =
    context.evidence.probes.agent.requestHeaders['accept'] ??
    context.evidence.probes.agent.requestHeaders['Accept'] ??
    null
  return {
    earned,
    evidence: [
      measured('We asked for', asked === null ? 'not recorded' : acceptSummary(asked)),
      measured('Format we got', agent.contentType ?? 'not stated'),
      measured('Content was HTML', yesNo(bodyIsHtml)),
      ...(linkedCopy === null ? [] : [measured('Linked Markdown copy', linkedCopyLine(linkedCopy))]),
    ],
    remedy: context.negotiated
      ? undefined
      : linkedWorks
        ? 'Your linked Markdown copy works. For full credit, also send it from the page address when an AI assistant asks for Markdown, so assistants get it without a second request.'
        : typeIsMachine
          ? 'Your server labels this response as Markdown, text or JSON but sends HTML. Send the format the Content-Type header names.'
          : 'When an AI assistant asks for Markdown, answer from the same address with a Markdown copy of the page and `Content-Type: text/markdown`. Assistants get your facts without the menus, scripts and styling, which are usually most of the page.',
  }
}

function linkedCopyLine(copy: LinkedCopy): string {
  if (copy.status === 'checked') {
    return `loaded as Markdown from ${copy.url} (${plainBytes(copy.representation?.bytes ?? 0)})`
  }
  if (copy.status === 'broken') return `did not load as Markdown from ${copy.url} (${copy.reason ?? 'error'})`
  return `linked at ${copy.url}, not checked in this scan`
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
      documentAlternates.push(`${link.type} at ${link.href}`)
    }
  }

  const total = headerAlternates.length + documentAlternates.length
  const broken = context.linkedCopy !== null && context.linkedCopy.status === 'broken'
  if (broken && context.linkedCopy !== null) {
    return {
      earned: 0,
      evidence: [measured('Linked Markdown copy', linkedCopyLine(context.linkedCopy))],
      remedy: `The Markdown copy this page links to did not load (${context.linkedCopy.reason ?? 'error'}). Fix the file or the link.`,
    }
  }
  return {
    earned: total > 0 ? SUBPOINTS.declaredAlternates.full : 0,
    evidence: [
      measured(
        'Link header pointing to the Markdown copy',
        headerAlternates.length === 0
          ? 'none'
          : headerAlternates.map((link) => `${link.type ?? '?'} at ${link.url}`).join(', '),
      ),
      measured(
        'Link tag in the page pointing to the Markdown copy',
        documentAlternates.length === 0 ? 'none' : documentAlternates.join(', '),
      ),
    ],
    remedy:
      total > 0
        ? undefined
        : 'Tell assistants where the Markdown copy is. Add `<link rel="alternate" type="text/markdown" href="…">` to the page, or send the same thing as a `Link` header.',
  }
}

function checkVaryAccept(context: ScoreContext): CheckOutcome {
  const negotiated = context.negotiated
  const { agentCapture, browserCapture } = context
  const agentVary = headerTokens(header(agentCapture.headers, 'vary'))
  const browserVary =
    browserCapture === null ? [] : headerTokens(header(browserCapture.headers, 'vary'))
  const declared = agentVary.includes('accept') || browserVary.includes('accept')

  const evidence = [
    measured('Vary header sent to AI assistants', header(agentCapture.headers, 'vary') ?? 'not sent'),
    measured(
      'Vary header sent to browsers',
      browserCapture === null
        ? 'not checked'
        : (header(browserCapture.headers, 'vary') ?? 'not sent'),
    ),
  ]

  // Gated on D2.1: `Vary: Accept` on a response that does not vary by Accept is
  // a claim about caching that is not true. Fixture 035 pins it.
  if (!negotiated) {
    return {
      earned: 0,
      evidence: [
        ...evidence,
        measured(
          'Counts',
          context.linkedCopy?.status === 'checked'
            ? 'only when the page address itself sends the Markdown copy, so 0 for now'
            : COUNTS_ONCE_COPY,
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
        'This address sends the Markdown copy or the HTML depending on what is asked for, but does not send `Vary: Accept`. A shared cache can hand the Markdown to a shopper, or the HTML to an assistant.',
      evidence,
    })
  }

  return {
    earned: declared ? SUBPOINTS.varyAccept.full : 0,
    evidence,
    remedy: declared
      ? undefined
      : 'Send `Vary: Accept` on every response from an address that serves a Markdown copy, so caches keep the two versions apart.',
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

/** The facts in a linked Markdown copy, read with the page's own profile and currency. */
function linkedCopyFacts(context: ScoreContext, copy: LinkedCopy): readonly ExtractedFact[] {
  if (copy.representation === null) return []
  return extractFacts(copy.representation, {
    profile: context.profile,
    ruleset: context.ruleset,
    baseUrl: copy.representation.finalUrl,
    origin: context.evidence.target.origin,
    currencyHint: currencyHintOf(context.structural, context.agent),
  })
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

function checkSubstanceParity(context: ScoreContext): CheckOutcome {
  const { agentFacts, browserFacts, browser, evidence: bundle } = context
  // ARS 0.3: a linked Markdown copy that loaded is compared the same way as a
  // negotiated one. It has no confirming probe, so a difference costs the
  // points and raises no flag, the conservative branch below.
  const linked =
    !context.negotiated && context.linkedCopy?.status === 'checked' ? context.linkedCopy : null
  const htmlFacts = browser !== null ? browserFacts : agentFacts

  if ((!context.negotiated && linked === null) || (linked === null && browser === null)) {
    return {
      earned: 0,
      evidence: [
        heuristic(
          'Counts',
          !context.negotiated
            ? COUNTS_ONCE_COPY
            : 'not checked, because this scan has no browser request to compare',
        ),
      ],
    }
  }

  const agentValues = factView(linked === null ? agentFacts : linkedCopyFacts(context, linked))
  const browserValues = factView(linked === null ? browserFacts : htmlFacts)
  const { compared, divergent } = divergentKinds(agentValues, browserValues, PARITY_KINDS)

  const evidenceLines = [
    heuristic(
      'Facts compared',
      compared.length === 0
        ? 'none appear in both the Markdown copy and the page'
        : factList(compared),
    ),
    ...(compared.length === 0
      ? []
      : [
          heuristic(
            'Values',
            divergent.length === 0
              ? 'match'
              : divergent
                  .map(
                    (entry) =>
                      `${factName(entry.kind)}: Markdown copy ${entry.left}, page ${entry.right}`,
                  )
                  .join('; '),
          ),
        ]),
  ]

  if (compared.length === 0) {
    return {
      earned: 0,
      evidence: evidenceLines,
      remedy:
        'State the same key facts, such as name and price, in the Markdown copy and in the page, so the two can be checked against each other.',
    }
  }

  if (divergent.length === 0)
    return { earned: SUBPOINTS.substanceParity.full, evidence: evidenceLines }

  // §3.8: divergence must REPRODUCE on a third confirming probe taken ≥30s later
  // before the flag is set. Inventory and price genuinely change between two
  // sequential requests, and a one-shot difference is not evidence of anything.
  // A linked copy never has one, so it always takes the unflagged branch.
  const confirm = linked === null ? bundle.probes.parityConfirm : null
  const confirmCapture = confirm !== null && confirm.result.ok ? confirm.result.capture : null
  const confirmRep = confirmCapture === null ? null : buildRepresentation(confirmCapture)
  if (confirmRep === null) {
    return {
      earned: 0,
      evidence: [
        ...evidenceLines,
        heuristic('Second look', 'not taken, so this difference was seen once and is not flagged'),
      ],
      remedy:
        'The Markdown copy and the page showed different values for a key fact. That can happen when a price or stock level changes between requests. If it repeats, build both from the same source.',
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
          'Second look',
          'the difference was gone, so we treat it as a value that changed between requests',
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
          `The Markdown copy showed ${factName(entry.kind)} ${entry.left}; the HTML page showed ${entry.right}. We saw the same difference on two requests taken apart.`,
      )
      .join(' '),
    evidence: evidenceLines,
  })

  return {
    earned: 0,
    evidence: [...evidenceLines, heuristic('Second look', 'the difference was still there')],
    remedy:
      'Show the same values in the Markdown copy and the page, ideally by building both from one source. We report what each version said and do not judge which is right.',
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
      heuristic('Key facts for this kind of page', factList(context.profile.core)),
      heuristic('Found', `${math.coreFound} of ${context.profile.core.length}`),
      heuristic('Missing', missing.length === 0 ? 'none' : factList(missing)),
      heuristic(
        'Extra facts found',
        `${math.extendedFound} of ${context.profile.extended.length}`,
      ),
      heuristic(
        'Credit for the facts',
        `${math.coveragePct}% (a fact stated in both the text and structured data counts in full)`,
      ),
      heuristic(
        'Credit kept for length',
        `${math.densityPct}% (${math.coreFound + math.extendedFound} facts in ${plainBytes(context.agent.bytes)}; the more text around each fact, the less is kept)`,
      ),
    ],
    remedy:
      missing.length > 0
        ? `Add the ${factList(missing)} to what AI assistants receive. An assistant can only repeat what the page states.${
            missing.includes('primary-action-url')
              ? ' For the main action link, use a label that starts with a common action word, such as Buy, Book, Order, Contact, Sign up, Get started or Request a quote.'
              : ''
          }`
        : earned === weight
          ? undefined
          : math.coveragePct < 100
            ? 'Repeat the key facts in both the visible text and the structured data. A fact stated once gets half credit.'
            : 'Your key facts are all there, but there is a lot of page around them, so this keeps only part of its credit. A Markdown copy for AI assistants that leads with the facts is the simplest fix; trimming the page also helps.',
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
        'Size AI assistants had to read',
        `${plainBytes(context.agent.bytes)}${context.agent.truncated ? ' or more (cut off at the limit)' : ''}`,
      ),
      measured(
        `Typical size for a ${context.profile.pageKind === 'unknown' ? 'general' : context.profile.pageKind} page`,
        plainBytes(reference),
      ),
      measured(
        'Compared with typical',
        ratio <= 100 ? 'at or under typical' : `about ${divRoundHalfUp(ratio, 100)} times typical`,
      ),
    ],
    remedy:
      earned === full
        ? undefined
        : 'Send AI assistants a Markdown copy, which carries the facts without the page code, or make the page lighter. Scripts, inline styles and repeated menus are usually most of the size.',
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
    evidence: [
      measured('Different numbers an answer could quote', `${count} (prices, sizes, percentages, dates)`),
    ],
    remedy:
      earned === full
        ? undefined
        : 'Write the numbers people ask about in the page text: prices, sizes, hours, fees and dates. Assistants quote numbers they can read.',
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
    evidence: [heuristic('Labelled facts, like "Returns: 60 days"', `${count}`)],
    remedy:
      earned === full
        ? undefined
        : 'Label your facts. A line like "Returns: 60 days" can be quoted as it is. The same fact inside a paragraph has to be worked out.',
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
    evidence: [measured('Table rows that compare options', `${rows}`)],
    remedy:
      earned === full
        ? undefined
        : 'Put options side by side in a table, one row each. Assistants answering "which one?" use rows they can line up.',
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
      evidence: [heuristic('First key fact', 'none found, so there is nothing to place')],
    }
  }
  const firstKind = context.facts.find((fact) => fact.offset === first)?.kind
  return {
    earned: atMost(context.ruleset.thresholds['fact-position.first-core-fact-offset'], first),
    evidence: [
      measured('First key fact appears', first === 0 ? 'at the very start' : `after ${plainBytes(first)}`),
      heuristic('Which fact', firstKind === undefined ? 'unknown' : factName(firstKind)),
    ],
    remedy:
      first <= 512
        ? undefined
        : 'Put the key facts near the top of what AI assistants receive. Assistants often read only the start.',
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
        measured('Opening section', `the first ${plainBytes(size)}`),
        heuristic('Key facts in it', 'none found, so there is nothing to place'),
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
      measured(
        'Opening section',
        `the first ${plainBytes(size)} (a ${divisor === 5 ? 'fifth' : `1/${divisor}`} of the page, at least ${plainBytes(floor)})`,
      ),
      heuristic('Key facts in it', `${inside} of the ${offsets.length} found (${pct}%)`),
    ],
    remedy:
      pct >= 90
        ? undefined
        : 'Move the key facts into the first part of the page. Facts further down cost an assistant a full read.',
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
      evidence: [measured('HTML page', 'not checked, because no HTML was returned')],
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
      measured('JSON-LD blocks that could be read', `${parsed} of ${blocks}`),
      measured('Microdata items', String(microdata)),
      measured('RDFa items', String(rdfa)),
    ],
    remedy:
      earned === split.clean
        ? undefined
        : blocks > parsed
          ? 'At least one JSON-LD block has a syntax error, so it cannot be read. Check it with a JSON validator.'
          : 'Add a JSON-LD block describing this page, such as a schema.org Product with its price. Search engines and some AI assistants read it.',
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
        measured('Schema.org type', 'none found'),
        measured('Properties we look for', required.join(', ') || 'none'),
        measured('Where we look', 'JSON-LD. Microdata counts toward the check above, not this one.'),
      ],
      remedy:
        'Give the JSON-LD a schema.org type that matches the page, such as Product, LocalBusiness or Article, with the properties listed.',
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
      measured('Schema.org type', node.types.join(', ')),
      measured('Properties present', `${satisfied.length} of ${required.length}`),
      measured('Missing', missing.length === 0 ? 'none' : missing.join(', ')),
    ],
    remedy:
      missing.length === 0
        ? undefined
        : `Add ${missing.join(', ')} to the ${node.types[0] ?? 'main'} item in your JSON-LD.`,
  }
}

function checkTextAgreement(context: ScoreContext): CheckOutcome {
  const { structuralFacts } = context
  const fromJsonLd = factView(structuralFacts.filter((fact) => fact.source === 'json-ld'))
  const fromPage = factView(structuralFacts.filter((fact) => fact.source !== 'json-ld'))
  const { compared, divergent } = divergentKinds(fromJsonLd, fromPage, PARITY_KINDS)

  const evidenceLines = [
    heuristic(
      'Facts compared',
      compared.length === 0
        ? 'none appear in both the structured data and the page text'
        : factList(compared),
    ),
    ...(compared.length === 0
      ? []
      : [
          heuristic(
            'Values',
            divergent.length === 0
              ? 'match'
              : divergent
                  .map(
                    (entry) =>
                      `${factName(entry.kind)}: structured data ${entry.left}, page ${entry.right}`,
                  )
                  .join('; '),
          ),
        ]),
  ]

  if (compared.length === 0) {
    return {
      earned: 0,
      evidence: evidenceLines,
      remedy:
        'State the key facts, such as name and price, in both the structured data and the visible page, so the two can be checked against each other.',
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
            `The structured data says ${factName(entry.kind)} ${entry.left}; the visible page says ${entry.right}.`,
        )
        .join(' '),
      evidence: evidenceLines,
    })
    return {
      earned: 0,
      evidence: evidenceLines,
      remedy:
        'Build the structured data from the same source as the visible page, so the two cannot disagree.',
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
      message: `The Markdown copy and the HTML page name different main addresses: ${agentCanonical} and ${htmlCanonical}.`,
      evidence: [
        measured('Main address given to AI assistants', agentCanonical),
        measured('Main address in the HTML', htmlCanonical),
      ],
    })
  }

  return {
    earned:
      (present ? split.present : 0) +
      (absolute ? split.absolute : 0) +
      (consistent ? split.consistentAcrossProbes : 0),
    evidence: [
      measured('Canonical address in the HTML', htmlCanonical ?? 'none'),
      measured('Canonical address AI assistants got', agentCanonical ?? 'none'),
      measured('Full address with https://', yesNo(absolute)),
      measured('Same for AI assistants and browsers', yesNo(consistent)),
    ],
    remedy:
      consistent && absolute
        ? undefined
        : htmlCanonical === null
          ? 'Add `<link rel="canonical" href="https://…">` with the full address of the page, so assistants know which address to cite.'
          : agentCanonical === null
            ? 'Your Markdown copy has no canonical address. Send `Link: <https://…>; rel="canonical"` with it, pointing at the page.'
            : !consistent
              ? 'Use one canonical address, written in full, for the page and its Markdown copy.'
              : 'Write the canonical address in full, starting with https://.',
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
      measured('Cache-Control header', cacheControl ?? 'not sent'),
      measured('ETag header', etag ?? 'not sent'),
      measured('Last-Modified header', lastModified ?? 'not sent'),
    ],
    remedy:
      sane && validator
        ? undefined
        : 'Send a `Cache-Control` header with a lifetime, plus an `ETag` or `Last-Modified` header, so repeat visits can skip unchanged pages.',
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
      evidence: [measured('/llms.txt', body === null ? 'not found' : 'empty')],
      remedy:
        'Publish /llms.txt with a `#` title, a short summary and links to your main pages.',
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
      measured('/llms.txt', `found, ${body.length} characters`),
      measured('Has a # title', yesNo(hasTitle)),
      measured('Has links', yesNo(hasLinks)),
    ],
    remedy: specShaped
      ? undefined
      : 'Start /llms.txt with a `#` title and add at least one link written as `[name](url)`.',
  }
}

function checkSitemap(context: ScoreContext): CheckOutcome {
  return {
    earned: context.policy.sitemapDeclared ? SUBPOINTS.sitemap.full : 0,
    evidence: [
      measured('Sitemap listed in robots.txt', yesNo(context.policy.sitemapDeclared)),
      measured(
        'Sitemaps',
        context.robots === null ? 'none' : context.robots.sitemaps.join(', ') || 'none',
      ),
    ],
    remedy: context.policy.sitemapDeclared
      ? undefined
      : 'Add a line like `Sitemap: https://example.com/sitemap.xml` to robots.txt.',
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
      declarations.push(`Link header (${link.rel.join(' ')}) at ${link.url}`)
    else if (link.type !== null && ENDPOINT_TYPES.includes(link.type))
      declarations.push(`Link header (${link.type}) at ${link.url}`)
  }

  if (context.structural !== null && context.structural.doc !== null) {
    for (const link of context.structural.doc.links) {
      if (link.href === null) continue
      if (link.rel.some((rel) => ENDPOINT_RELS.includes(rel)))
        declarations.push(`link tag (${link.rel.join(' ')}) at ${link.href}`)
      else if (link.type !== null && ENDPOINT_TYPES.includes(link.type))
        declarations.push(`link tag (${link.type}) at ${link.href}`)
    }
  }

  const llms = bodyOf(context.evidence.probes.llmsTxt)
  if (llms !== null) {
    MARKDOWN_LINK.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MARKDOWN_LINK.exec(llms)) !== null) {
      const url = (match[1] ?? '').toLowerCase()
      if (ENDPOINT_PATH_MARKERS.some((marker) => url.includes(marker)))
        declarations.push(`llms.txt link to ${match?.[1] ?? url}`)
    }
  }

  const ucp = bodyOf(context.evidence.probes.wellKnownUcp)
  if (ucp !== null && ucp.trim().length > 0) declarations.push('/.well-known/ucp')
  // Both probes usually carry the same `Link` header; list each once.
  const unique = [...new Set(declarations)]

  return {
    earned: declarations.length > 0 ? SUBPOINTS.machineEndpoint.full : 0,
    evidence: [
      measured('Feeds or APIs we found', unique.length === 0 ? 'none' : unique.join('; ')),
      measured('Where we looked', 'link tags, Link headers, /llms.txt and /.well-known/ucp'),
    ],
    remedy:
      declarations.length > 0
        ? undefined
        : 'Point to a product feed, API or calendar from the page with a `<link>` tag or a `Link` header. We only count ones the page names.',
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
        'This site blocks AI training crawlers but lets AI assistants in. That does not affect the score.',
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
          'robots.txt asks Rebilder’s scanner not to read this site, so we did not score the page.',
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
        'This site’s robots.txt blocks AI assistants by name. We respect that choice and do not grade the page.',
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
          'The site answered our scanner with a bot check or a block, so we did not grade the page. AI assistants may be blocked the same way.',
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
      message: `The site answered our scanner with HTTP ${agentCapture.status}, so we did not grade the page. AI assistants may be blocked the same way.`,
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
      message: `The page is larger than our ${plainBytes(ruleset.maxBodyBytes)} reading limit, so we did not score it. The facts and sizes would both be incomplete.`,
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

  const negotiated = isMachineCopy(agentCapture)
  const context: ScoreContext = {
    negotiated,
    linkedCopy: negotiated ? null : linkedCopyOf(evidence, agentCapture, browserCapture),
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
      message: `This page says it is behind a paywall (${paywall}). We scored the part we were shown.`,
      evidence: [measured('Paywall signal', paywall)],
    })
  }

  // ── the 22 checks ────────────────────────────────────────────────────────
  const math = coverageMath(context)
  const offsets = coreOffsets(context)
  const negotiatedResponse = checkNegotiatedResponse(context)

  const checks: ArsCheck[] = [
    buildCheck(ruleset, 'retrievability.reachable', checkReachable(context)),
    buildCheck(ruleset, 'retrievability.robots-policy', checkRobotsPolicy(context)),
    buildCheck(ruleset, 'retrievability.render-independence', checkRenderIndependence(context)),
    buildCheck(ruleset, 'machine-representation.negotiated-response', negotiatedResponse),
    buildCheck(
      ruleset,
      'machine-representation.declared-alternates',
      checkDeclaredAlternates(context),
    ),
    buildCheck(
      ruleset,
      'machine-representation.vary-accept',
      checkVaryAccept(context),
    ),
    buildCheck(
      ruleset,
      'machine-representation.substance-parity',
      checkSubstanceParity(context),
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
  const negotiatedBytes = negotiated ? agent.bytes : null
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
